import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Fuel } from "lucide-react";
import { useTranslation } from "react-i18next";
import banIcon from "@/assets/icons/ban.svg";
import checkIcon from "@/assets/icons/check.svg";
import dangerIcon from "@/assets/icons/danger.svg";
import dispenserIcon from "@/assets/icons/dispenser.svg";
import dropletIcon from "@/assets/icons/fuel.svg";
import eyeOffIcon from "@/assets/icons/eye-off.svg";
import fullTankIcon from "@/assets/icons/full-tank.svg";
import loaderIcon from "@/assets/icons/loader.svg";
import pauseIcon from "@/assets/icons/pause.svg";
import playIcon from "@/assets/icons/play.svg";
import powerIcon from "@/assets/icons/power.svg";
import shieldIcon from "@/assets/icons/shield.svg";
import wifiOffIcon from "@/assets/icons/wifi-off.svg";
import xCircleIcon from "@/assets/icons/x-circle.svg";
import type { AuthMode, FpState, FpStatus, FpStatusTag, NozzleSnapshot } from "../types/api";
import { pausedInfo, statusTag } from "../types/api";
import { useAppStore } from "../store";
import { FillSetupModal } from "./FillSetupModal";
import { PumpCardForm, PumpCardProgress } from "./PumpCardForm";

export type FillMode = "full" | "volume" | "amount";

const fmtSum = new Intl.NumberFormat("uz-UZ");

function InlineIcon({
  src,
  alt = "",
  className = "",
  animated = false,
}: {
  src: string;
  alt?: string;
  className?: string;
  animated?: boolean;
}) {
  return (
    <img
      src={src}
      alt={alt}
      className={`${className} ${animated ? "animate-spin" : ""}`.trim()}
      aria-hidden={alt === "" ? true : undefined}
      draggable={false}
    />
  );
}

function ContinuationMeterColumn({
  label,
  volume,
  amount,
  volumeClass = "text-text-secondary",
  amountClass = "text-text-muted",
}: {
  label: string;
  volume: number;
  amount: number;
  volumeClass?: string;
  amountClass?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5 px-0.5">
      <span className="w-full truncate text-center text-xs font-bold uppercase tracking-wide text-text-muted">
        {label}
      </span>
      <span
        className={`w-full truncate text-center font-mono text-lg font-black tabular-nums leading-none sm:text-xl ${volumeClass}`}
      >
        {volume.toFixed(2)} L
      </span>
      <span
        className={`w-full truncate text-center font-mono text-base font-black tabular-nums leading-tight ${amountClass}`}
      >
        {fmtSum.format(amount)}
      </span>
    </div>
  );
}

/** Parse a volume target from pre_auth_preset for progress display. */
function parseVolumeTargetLiters(preset: string | null | undefined): number | null {
  if (!preset) return null;
  const m = preset.match(/([\d.,]+)\s*L/i);
  if (!m) return null;
  const v = Number.parseFloat(m[1].replace(",", "."));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Parse an amount target (SUM) from pre_auth_preset for progress display. */
function parseAmountTargetSum(preset: string | null | undefined): number | null {
  if (!preset) return null;
  const m = preset.match(/([\d.,\s]+)\s*sum/i);
  if (!m) return null;
  const v = Number.parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(v) && v > 0 ? v : null;
}

type LimitDisplay = { kindLabel: string; value: string };

function preAuthLimitDisplay(
  preset: string | null | undefined,
  t: (k: string) => string,
): LimitDisplay {
  const raw = (preset ?? "Full tank").trim();
  const lower = raw.toLowerCase();
  if (lower === "full" || lower === "full tank") {
    return { kindLabel: t("dispenser.limitFillMode"), value: t("pumpForm.fullTank") };
  }
  if (/\d/.test(raw) && (raw.includes(" L") || raw.endsWith("L") || lower.endsWith(" l"))) {
    return { kindLabel: t("dispenser.limitVolumeLimit"), value: raw };
  }
  if (lower.includes("sum")) {
    return { kindLabel: t("dispenser.limitAmountLimit"), value: raw.replace(/\s*sum\s*/gi, " SUM") };
  }
  return { kindLabel: t("dispenser.limitAuthorizedLimit"), value: raw };
}

const STATUS_ICON_MAP: Partial<Record<FpStatusTag, { src: string; animated?: boolean }>> = {
  DELIVERING: { src: dropletIcon },
  PRE_AUTHORIZED: { src: shieldIcon },
  NOZZLE_UP: { src: fullTankIcon },
  AUTHORIZING: { src: loaderIcon, animated: true },
  DONE: { src: checkIcon },
  STOPPED: { src: dangerIcon },
  OFFLINE: { src: wifiOffIcon },
};

function StatusIcon({ tag, className = "" }: { tag: FpStatusTag; className?: string }) {
  const icon = STATUS_ICON_MAP[tag] ?? { src: powerIcon };
  return <InlineIcon src={icon.src} className={className} animated={icon.animated} />;
}

function classicStatusLabel(
  tag: FpStatusTag,
  isPaused: boolean,
  hasActivePreAuth: boolean,
  t: (key: string) => string,
): string {
  const key = isPaused ? "STOPPED" : hasActivePreAuth ? "PRE_AUTHORIZED" : tag;
  const label = t(`classic.statusLabels.${key}`);
  return label === `classic.statusLabels.${key}` ? t("classic.statusLabels.UNKNOWN") : label;
}

export interface AuthorizeRequest {
  fpId: string;
  nozzleIndex: number | null;
  fillMode: FillMode;
  /** Litres when fillMode is volume; minor-unit sum when fillMode is amount. */
  limitValue: number | null;
  priceOverride: number | null;
}

export interface DispenserCardProps {
  state: FpState;
  fpNozzles: NozzleSnapshot[];
  /** Fueling position enabled in site config. */
  positionActive?: boolean;
  defaultAuthMode?: AuthMode;
  /** Compact layout for 6+ card grids. */
  compact?: boolean;
  onHide?: () => void;
  onAuthorize: (req: AuthorizeRequest) => void;
  onPreAuthorize?: (req: AuthorizeRequest) => void;
  onCancelPreAuth?: (fpId: string) => void;
  onStop: (fpId: string) => void;
  onResumeFill: (fpId: string, stoppedTxId: string) => void;
  onContinueFill: (fpId: string, stoppedTxId: string) => void;
  onCloseStopped: (fpId: string, stoppedTxId: string) => void;
  onDismissSale?: (fpId: string) => void;
  /** When true and pump is idle/waiting, block authorization and prompt to start a shift. */
  shiftRequired?: boolean;
  onStartShift?: () => void;
  /** When true, the Stop/Pause button acts as a final stop (no resume). */
  useStopMode?: boolean;
  /** When true, show a Cancel button that stops + immediately closes the transaction. */
  useCancelMode?: boolean;
  onCancel?: (fpId: string) => void;
  gilbarcoMode?: boolean;
}

export function DispenserCard({
  state,
  fpNozzles,
  positionActive = true,
  defaultAuthMode = "reactive",
  compact = false,
  onHide,
  onAuthorize,
  onPreAuthorize,
  onCancelPreAuth,
  onStop,
  onResumeFill,
  onContinueFill,
  onCloseStopped,
  onDismissSale,
  shiftRequired = false,
  onStartShift,
  useStopMode = false,
  useCancelMode = false,
  onCancel,
  gilbarcoMode = false,
}: DispenserCardProps) {
  const { t } = useTranslation();
  const [setupOpen, setSetupOpen] = useState(false);
  const [formStart, setFormStart] = useState<{ disabled: boolean; onStart: () => void }>({
    disabled: true,
    onStart: () => { },
  });
  const nozzleRemovedAt = useAppStore((s) => s.nozzleRemovedAt[state.fp_id]);
  const preAuthTimeoutFpId = useAppStore((s) => s.preAuthTimeoutFpId);
  const preAuthNozzleMismatch = useAppStore((s) => s.preAuthNozzleMismatch);
  const siteSnapshot = useAppStore((s) => s.siteSnapshot);
  const lastSaleOutcome = useAppStore((s) => s.lastSaleOutcome[state.fp_id]);
  const lastSale = useAppStore((s) => s.lastSale[state.fp_id]);
  const clearNozzleRemovedNotice = useAppStore((s) => s.clearNozzleRemovedNotice);
  const clearPreAuthTimeoutNotice = useAppStore((s) => s.clearPreAuthTimeoutNotice);
  const clearPreAuthNozzleMismatch = useAppStore((s) => s.clearPreAuthNozzleMismatch);
  const showNozzleRemovedBanner = nozzleRemovedAt != null;
  const showPreAuthTimeoutBanner = preAuthTimeoutFpId === state.fp_id;
  const showPreAuthMismatchBanner =
    preAuthNozzleMismatch != null && preAuthNozzleMismatch.fpId === state.fp_id;

  useEffect(() => {
    if (nozzleRemovedAt == null) return;
    const t = window.setTimeout(() => clearNozzleRemovedNotice(state.fp_id), 6000);
    return () => window.clearTimeout(t);
  }, [nozzleRemovedAt, state.fp_id, clearNozzleRemovedNotice]);

  useEffect(() => {
    if (!showPreAuthTimeoutBanner) return;
    const t = window.setTimeout(() => clearPreAuthTimeoutNotice(), 5000);
    return () => window.clearTimeout(t);
  }, [showPreAuthTimeoutBanner, clearPreAuthTimeoutNotice]);

  useEffect(() => {
    if (!showPreAuthMismatchBanner) return;
    const t = window.setTimeout(() => clearPreAuthNozzleMismatch(), 10000);
    return () => window.clearTimeout(t);
  }, [showPreAuthMismatchBanner, clearPreAuthNozzleMismatch]);

  const configuredNozzles = useMemo(() => {
    if (fpNozzles.length > 0) return fpNozzles;
    return siteSnapshot?.positions.find((p) => p.fp_id === state.fp_id)?.nozzles ?? [];
  }, [fpNozzles, siteSnapshot, state.fp_id]);

  const activeNozzles = useMemo(
    () => configuredNozzles.filter((n) => n.active),
    [configuredNozzles],
  );

  const effectiveNozzle =
    state.nozzle_index ?? (activeNozzles.length === 1 ? activeNozzles[0]!.index : null);

  const activeNozzle = useMemo(() => {
    if (effectiveNozzle != null) {
      return configuredNozzles.find((n) => n.index === effectiveNozzle) ?? null;
    }
    if (state.product_id != null) {
      return configuredNozzles.find((n) => n.product_id === state.product_id) ?? null;
    }
    return null;
  }, [configuredNozzles, effectiveNozzle, state.product_id]);

  const displayPrice = useMemo(() => {
    if (state.price > 0) return state.price;
    if (activeNozzle?.price) return activeNozzle.price;
    return 0;
  }, [state.price, activeNozzle]);

  const productLabel = state.product_name ?? activeNozzle?.product_name ?? null;
  const productColor = state.product_color ?? activeNozzle?.product_color ?? "#888";

  const liftedNozzleCaption = useMemo(() => {
    const idx = state.nozzle_index ?? effectiveNozzle;
    if (idx == null) return null;
    const grade = productLabel ?? t("dispenser.gradeN", { n: idx });
    return t("dispenser.nozzleNGrade", { n: idx, grade });
  }, [state.nozzle_index, effectiveNozzle, productLabel, t]);

  const tag = statusTag(state.status as FpStatus);
  const paused = pausedInfo(state);
  const isDelivering = tag === "DELIVERING";
  const isPreAuthorized = tag === "PRE_AUTHORIZED";
  const hasActivePreAuth =
    isPreAuthorized ||
    (state.pre_auth_preset != null &&
      tag !== "DONE" &&
      tag !== "DELIVERING" &&
      tag !== "AUTHORIZING" &&
      tag !== "OFFLINE");
  const isIdle = tag === "IDLE";
  const isNozzleUp = tag === "NOZZLE_UP";
  const isAuthorizing = tag === "AUTHORIZING";

  const prevTagRef = useRef(tag);
  const [formResetKey, setFormResetKey] = useState(0);
  useEffect(() => {
    const prev = prevTagRef.current;
    if (
      (prev === "NOZZLE_UP" && tag === "IDLE") ||
      (prev === "DONE" && tag === "IDLE")
    ) {
      setFormResetKey((k) => k + 1);
    }
    prevTagRef.current = tag;
  }, [tag]);
  const hasDeliveryPlan =
    state.pre_auth_preset != null && (isDelivering || isAuthorizing);
  const deliveryLimit = useMemo(
    () => preAuthLimitDisplay(state.pre_auth_preset, t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.pre_auth_preset, t],
  );
  const isDone = tag === "DONE";

  const holsterEndedSale = isDone && lastSaleOutcome === "holster_ended";
  const abortedSale = isDone && lastSaleOutcome === "aborted";
  // Auto-dismiss only when the nozzle is confirmed back in the holster.
  // "completed" means the delivery limit was reached but the nozzle may still be
  // in the customer's tank — dismissing immediately would reset the backend while
  // the pump is still physically active, causing flicker and offline flashes.
  const shouldAutoDismiss = holsterEndedSale || abortedSale;

  const onDismissSaleRef = useRef(onDismissSale);
  useEffect(() => { onDismissSaleRef.current = onDismissSale; });

  useEffect(() => {
    if (!shouldAutoDismiss) return;
    onDismissSaleRef.current?.(state.fp_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoDismiss, state.fp_id]);
  const isPaused = paused != null;
  const isAppPause = paused?.stop_source === "APP";
  const isAppStop = paused?.stop_source === "APP_FINAL";
  const isExternalPause = paused?.stop_source === "EXTERNAL";
  const hasContinuationBase =
    (state.base_volume ?? 0) > 0 &&
    tag !== "IDLE" &&
    tag !== "STOPPED" &&
    tag !== "DONE";
  const isContinuing =
    hasContinuationBase &&
    (tag === "DELIVERING" || tag === "AUTHORIZING");
  const usePreAuth = defaultAuthMode === "preauth";
  // Preauth can start from idle OR from a lift-first state (nozzle already up).
  const canOpenPreAuthSetup =
    (isIdle || isNozzleUp) && usePreAuth && !isPaused && !isContinuing && !hasActivePreAuth;
  const canOpenReactiveSetup =
    isNozzleUp && !usePreAuth && !isPaused && !isContinuing && !hasActivePreAuth;
  // No longer shown: the form is now available instead of blocking the operator.
  const showUnplannedLift = false;
  const isOffline = tag === "OFFLINE";
  const handleFormStart = (req: AuthorizeRequest) => {
    if (!positionActive) return;
    // Lift-first (nozzle already up) must use the reactive authorize path — the
    // backend skips PRE_AUTHORIZED and goes straight to AUTHORIZING, so calling
    // onPreAuthorize would time out waiting for a PRE_AUTHORIZED state that never arrives.
    if (canOpenPreAuthSetup && !isNozzleUp) onPreAuthorize?.(req);
    else onAuthorize(req);
  };

  const showPumpForm =
    positionActive &&
    !isOffline &&
    !isDelivering &&
    !isPaused &&
    !isDone &&
    !hasActivePreAuth &&
    !isAuthorizing &&
    (canOpenPreAuthSetup || canOpenReactiveSetup);
  const useSetupModal = compact;
  const showInlinePumpForm = showPumpForm && !useSetupModal;

  const kolonkaTitle =
    state.label?.trim() ||
    (state.fp_id.match(/\d+/) ? `${state.fp_id.match(/\d+/)![0]}-KOLONKA` : `${state.fp_id}-KOLONKA`);
  const isOnline = !isOffline;
  const statusTone = isOffline
    ? "offline"
    : isDelivering
      ? "delivering"
      : hasActivePreAuth
        ? "preauth"
        : isPaused
          ? "paused"
          : isDone
            ? "done"
            : isNozzleUp
              ? "nozzle_up"
              : "idle";
  const cardMinH = compact ? "min-h-0 h-full" : "min-h-[560px]";

  const statusHeader = useMemo(() => {
    const statusLabel = classicStatusLabel(tag, isPaused, hasActivePreAuth, t);
    let subtitle = state.label;
    let rightMeta: string | null = null;

    if (isDelivering && hasDeliveryPlan) {
      subtitle = `${productLabel ?? "—"} · ${deliveryLimit.kindLabel}`;
      rightMeta = deliveryLimit.value;
    } else if (isDelivering) {
      subtitle = productLabel ? `${productLabel} — ${t("dispenser.statusDelivering")}` : t("dispenser.statusDelivering");
    } else if (isAuthorizing && hasDeliveryPlan) {
      subtitle = t("dispenser.statusAuthorizingWith", { limitKind: deliveryLimit.kindLabel });
      rightMeta = deliveryLimit.value;
    } else if (isDone && holsterEndedSale) {
      subtitle = t("dispenser.statusDoneHolstered");
      rightMeta = `${state.volume.toFixed(2)} L · ${fmtSum.format(state.amount)} SUM`;
    } else if (isDone && abortedSale) {
      subtitle = t("dispenser.statusDoneAborted");
    } else if (isDone) {
      subtitle = t("dispenser.statusDone");
    } else if (isExternalPause) {
      subtitle = t("dispenser.statusExternalPause");
    } else if (isAppPause) {
      subtitle = t("dispenser.statusAppPause");
    } else if (hasActivePreAuth) {
      subtitle = isNozzleUp
        ? (liftedNozzleCaption ?? t("dispenser.preAuthAwaitingLift"))
        : t("dispenser.preAuthAwaitingCustomer");
    } else if (isNozzleUp) {
      subtitle = usePreAuth && !hasActivePreAuth
        ? t("dispenser.statusNozzleUpPreauth")
        : (liftedNozzleCaption ?? t("dispenser.statusNozzleUp"));
    } else if (isIdle) {
      subtitle = usePreAuth
        ? t("dispenser.statusIdlePreauth")
        : t("dispenser.statusIdle");
    } else if (isOffline) {
      subtitle = t("dispenser.statusOffline");
    }

    return { statusLabel, subtitle, rightMeta };
  }, [
    tag,
    state.label,
    state.volume,
    state.amount,
    isDelivering,
    hasDeliveryPlan,
    productLabel,
    deliveryLimit,
    isAuthorizing,
    isDone,
    holsterEndedSale,
    abortedSale,
    isExternalPause,
    isAppPause,
    isPaused,
    hasActivePreAuth,
    isNozzleUp,
    isIdle,
    isOffline,
    usePreAuth,
    liftedNozzleCaption,
  ]);

  const displayVolume = isPaused ? (paused?.stopped_volume ?? 0) : state.volume;
  const progressTarget = parseVolumeTargetLiters(state.pre_auth_preset);
  const amountTarget = parseAmountTargetSum(state.pre_auth_preset);
  // Lifetime pump totals for the currently selected product: prefer the matching
  // per-nozzle entry, fall back to the legacy single-nozzle fields.
  const pumpTotalizer = useMemo(() => {
    const match =
      effectiveNozzle != null
        ? state.pump_totals?.find((tt) => tt.nozzle_index === effectiveNozzle)
        : undefined;
    if (match) {
      return { nozzleIndex: match.nozzle_index, volume: match.volume, amount: match.amount, price: match.price };
    }
    if (state.pump_total_volume != null || state.pump_total_amount != null) {
      return {
        nozzleIndex: state.pump_total_nozzle_index ?? null,
        volume: state.pump_total_volume ?? null,
        amount: state.pump_total_amount ?? null,
        price: state.pump_total_price ?? null,
      };
    }
    return null;
  }, [
    effectiveNozzle,
    state.pump_totals,
    state.pump_total_nozzle_index,
    state.pump_total_volume,
    state.pump_total_amount,
    state.pump_total_price,
  ]);
  const showPumpTotalizer = pumpTotalizer != null && (isIdle || isDone || isPaused);

  return (
    <>
      <div
        className={`pump-card pump-card--${statusTone} ${cardMinH} relative flex w-full min-w-0 flex-col overflow-hidden rounded-xl border ${compact ? "pt-1.5" : "pt-4"} ${compact ? "gap-1 px-2 pb-1.5" : "gap-3 px-4 pb-4"} ${isDelivering || (isNozzleUp && !showUnplannedLift) ? "ring-1 ring-accent-emerald/25" : showUnplannedLift ? "ring-1 ring-accent-red/30" : ""
          } ${showPreAuthMismatchBanner ? "ring-2 ring-accent-red/50" : ""} ${!positionActive ? "opacity-60 grayscale-[50%]" : ""
          }`}
      >
        {/* Wrong-nozzle alert: a full-card RED overlay (same as the classic UI).
            Absolutely positioned so it never resizes the card, and pointer-events-none
            so the card underneath stays interactive. */}
        {showPreAuthMismatchBanner && (
          <div
            role="alert"
            className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-1.5 bg-accent-red/95 px-3 py-2 text-center text-white shadow-[inset_0_0_0_3px_rgb(var(--color-accent-red))] backdrop-blur-sm"
            title={t("mismatch.instructions")}
          >
            <span className="absolute inset-0 animate-pulse ring-4 ring-inset ring-white/30" aria-hidden />
            <AlertTriangle className="h-7 w-7 shrink-0 drop-shadow" />
            <span className="text-sm font-black uppercase leading-tight tracking-widest">
              {t("mismatch.wrongNozzle")}
            </span>
            <span className="text-[11px] font-semibold leading-snug text-red-50/90">
              {t("mismatch.instructions")}
            </span>
          </div>
        )}

        {/* Header */}
        <div className={`flex shrink-0 items-center justify-between border-b border-border-primary/20 ${compact ? "gap-1 pb-1.5" : "gap-2 pb-2"}`}>
          <div className={`flex min-w-0 items-center ${compact ? "gap-1.5" : "gap-2"}`}>
            <div className={`pump-card-icon-box flex shrink-0 items-center justify-center rounded border border-border-primary/40 bg-bg-input/50 ${compact ? "h-6 w-6" : "h-7 w-7"}`}>
              <InlineIcon
                src={dispenserIcon}
                className={`${compact ? "h-3.5 w-3.5" : "h-4 w-4"} opacity-55`}
              />
            </div>
            <h2
              className={`truncate font-black uppercase tracking-widest text-text-primary ${compact ? "text-base" : "text-lg"}`}
            >
              {kolonkaTitle}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {isNozzleUp && (
              <span
                className="pump-nozzle-lifted-badge flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-black uppercase tracking-wide"
                title={liftedNozzleCaption ?? t("dispenser.nozzleUp")}
              >
                <Fuel className="h-3.5 w-3.5 shrink-0" />
                <span className="whitespace-nowrap">{t("dispenser.nozzleUp")}</span>
              </span>
            )}
            {showUnplannedLift && (
              <span
                className="flex items-center gap-1 rounded-full bg-accent-red/15 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-accent-red"
                title={t("dispenser.nozzleLiftedNoPreAuth")}
              >
                <InlineIcon src={dangerIcon} className="h-3 w-3" />
                {compact ? "" : t("dispenser.noPreAuth")}
              </span>
            )}
            <span
              className={`pump-auth-badge ${isIdle ? "pump-auth-badge--idle" : usePreAuth ? "pump-auth-badge--preauth" : "pump-auth-badge--reactive"}`}
              title={isIdle ? t("dispenser.badgeIdleTitle") : usePreAuth ? t("dispenser.badgePreTitle") : t("dispenser.badgeReactiveTitle")}
            >
              {isIdle ? t("dispenser.badgeIdle") : usePreAuth ? t("dispenser.badgePre") : t("dispenser.badgeR")}
            </span>
            <div className="flex items-center gap-1">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? "bg-accent-emerald online-dot-glow" : "bg-text-muted"}`}
                title={isOnline ? t("dispenser.online") : t("dispenser.offline")}
                aria-label={isOnline ? t("dispenser.online") : t("dispenser.offline")}
              />
              <button
                type="button"
                onClick={onHide}
                className="shrink-0 text-text-muted opacity-35 hover:opacity-90 hover:text-text-secondary transition-opacity"
                title={t("dispenser.hideCard")}
              >
                <InlineIcon src={eyeOffIcon} className="h-3 w-3" />
              </button>
            </div>
          </div>
        </div>

        <div className={`flex min-h-0 flex-1 min-w-0 flex-col ${compact ? "gap-2" : "gap-2"}`}>
          {/* Status chip — always visible when idle, otherwise only when form is hidden */}
          {(!showPumpForm || isIdle || useSetupModal) && !hasActivePreAuth && (
            <div
              className={`pump-status-chip pump-status-chip--${statusTone} flex items-center gap-2 rounded-lg border ${compact ? "px-2 py-1.5" : "px-3 py-2.5"} ${compact ? "text-sm" : "text-base"}`}
            >
              <div className={`pump-status-icon-frame flex shrink-0 items-center justify-center rounded-md ${compact ? "h-7 w-7" : "h-9 w-9"}`}>
                <StatusIcon tag={tag} className={`${compact ? "h-4 w-4" : "h-5 w-5"} shrink-0`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-black uppercase tracking-wide text-text-muted">
                  {statusHeader.statusLabel}
                </p>
                <p className={`line-clamp-2 font-black leading-snug ${compact ? "text-lg" : "text-xl"} text-text-primary`}>{statusHeader.subtitle}</p>
              </div>
              {statusHeader.rightMeta ? (
                <span className={`shrink-0 rounded-md bg-bg-input/70 px-2 py-1 font-mono font-black tabular-nums text-text-primary ${compact ? "text-base" : "text-xl"}`}>{statusHeader.rightMeta}</span>
              ) : null}
            </div>
          )}

          {showUnplannedLift && (
            <div className="rounded-lg border border-accent-red/40 bg-accent-red/10 px-3 py-3">
              <div className="flex items-start gap-2">
                <InlineIcon src={dangerIcon} className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-accent-red">{t("dispenser.preAuthRequired")}</p>
                  <p className="mt-0.5 text-xs leading-snug text-text-secondary">
                    {t("dispenser.preAuthRequiredDesc")}
                  </p>
                </div>
              </div>
            </div>
          )}

          {hasActivePreAuth && !showPumpForm && (
            <div
              className={`rounded-lg border border-accent-amber/40 bg-accent-amber/10 ${compact ? "px-2 py-1.5" : "px-3 py-2"}`}
              role="status"
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: productColor }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className={`line-clamp-2 font-black leading-snug text-text-primary ${compact ? "text-base" : "text-lg"}`}>
                    {productLabel ?? "—"}
                  </p>
                  <p className={`font-mono font-black tabular-nums text-accent-amber ${compact ? "text-base" : "text-lg"}`}>
                    {preAuthLimitDisplay(state.pre_auth_preset, t).value}
                  </p>
                </div>
              </div>
              <p className={`text-text-tertiary ${compact ? "mt-0.5 text-xs" : "mt-1 text-xs"}`}>
                {isNozzleUp ? t("dispenser.preAuthAwaitingLift") : t("dispenser.preAuthAwaitingCustomer")}
              </p>
            </div>
          )}

          {(!showPumpForm || useSetupModal) && (
            isIdle ? (
              lastSale && (lastSale.volume > 0 || lastSale.amount > 0) ? (
                <div className={`flex items-center justify-between rounded-lg border border-border-primary/60 bg-bg-input/45 ${compact ? "px-2 py-1" : "px-2.5 py-1.5"}`}>
                  <p className="text-[10px] uppercase tracking-wide text-text-muted">{t("dispenser.lastFill")}</p>
                  <div className="flex items-baseline gap-2">
                    <span className={`font-mono font-black tabular-nums text-text-primary ${compact ? "text-base" : "text-lg"}`}>
                      {lastSale.volume.toFixed(2)} L
                    </span>
                    <span className={`font-mono font-black tabular-nums text-text-secondary ${compact ? "text-base" : "text-lg"}`}>
                      {fmtSum.format(lastSale.amount)}
                    </span>
                  </div>
                </div>
              ) : null
            ) : isDone ? (
              <div className={`rounded-lg border border-accent-emerald/35 bg-accent-emerald/10 ${compact ? "px-2.5 py-2" : "px-3 py-3"}`}>
                <p className={`font-bold uppercase tracking-wide text-accent-emerald ${compact ? "text-[10px] mb-1" : "text-xs mb-2"}`}>
                  {t("pumpForm.filled")}
                </p>
                <div className="flex items-baseline gap-3">
                  <span className={`font-mono font-black tabular-nums text-text-primary leading-none ${compact ? "text-3xl" : "text-4xl"}`}>
                    {state.volume.toFixed(2)}<span className={`font-semibold text-text-muted ${compact ? "text-sm" : "text-base"} ml-1`}>L</span>
                  </span>
                  <span className={`font-mono font-black tabular-nums text-accent-blue ${compact ? "text-2xl" : "text-3xl"}`}>
                    {fmtSum.format(state.amount)} <span className="text-text-muted font-normal text-xs">SUM</span>
                  </span>
                </div>
              </div>
            ) : (
              <div className={`pump-info-strip grid grid-cols-[1.35fr_0.65fr_1fr] gap-1.5 rounded-lg border ${compact ? "p-1.5" : "p-2"}`}>
                <div
                  className={`pump-info-tile pump-info-tile--product rounded-md border px-2 ${compact ? "py-1.5" : "py-2"}`}
                  style={{ borderLeftColor: productColor }}
                >
                  <p className="text-[10px] font-black uppercase tracking-wide text-text-muted">{t("dispenser.grade")}</p>
                  <p className={`truncate font-black leading-tight text-text-primary ${compact ? "text-lg" : "text-2xl"}`} title={productLabel ?? ""}>{productLabel ?? "—"}</p>
                </div>
                <div className={`pump-info-tile rounded-md border px-2 text-center ${compact ? "py-1.5" : "py-2"}`}>
                  <p className="text-[10px] font-black uppercase tracking-wide text-text-muted">{t("dispenser.nozzle")}</p>
                  <p className={`font-black leading-tight text-text-primary ${compact ? "text-xl" : "text-2xl"}`}>{effectiveNozzle ?? "—"}</p>
                </div>
                <div className={`pump-info-tile rounded-md border px-2 text-right ${compact ? "py-1.5" : "py-2"}`}>
                  <p className="text-[10px] font-black uppercase tracking-wide text-text-muted">{t("dispenser.price")}</p>
                  <p className={`font-mono font-black leading-tight tabular-nums text-accent-blue ${compact ? "text-xl" : "text-2xl"}`}>
                    {displayPrice > 0 ? fmtSum.format(displayPrice) : "—"}
                  </p>
                </div>
              </div>
            )
          )}

          {showInlinePumpForm ? (
            <div className="flex min-h-0 flex-1 min-w-0">
              <PumpCardForm
                key={formResetKey}
                fpId={state.fp_id}
                activeNozzles={activeNozzles}
                initialNozzle={effectiveNozzle}
                compact={compact}
                disabled={!positionActive}
                onStart={handleFormStart}
                onReadyChange={setFormStart}
              />
            </div>
          ) : null}

          {isContinuing && !showPumpForm && (
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-border-primary bg-bg-input/50 p-2">
              <ContinuationMeterColumn
                label={t("dispenser.base")}
                volume={state.base_volume ?? 0}
                amount={state.base_amount ?? 0}
              />
              <ContinuationMeterColumn
                label={t("dispenser.now")}
                volume={state.segment_volume ?? 0}
                amount={state.segment_amount ?? 0}
                volumeClass="text-accent-emerald"
              />
              <ContinuationMeterColumn
                label={t("dispenser.total")}
                volume={state.volume}
                amount={state.amount}
                volumeClass="text-text-primary"
                amountClass="text-accent-blue"
              />
            </div>
          )}

          {(isDelivering || isPaused || (hasActivePreAuth && displayVolume > 0)) && !showPumpForm && (
            <PumpCardProgress
              volume={displayVolume}
              amount={state.amount}
              targetLiters={progressTarget}
              targetAmount={amountTarget}
              compact={compact}
            />
          )}

          {showPumpTotalizer && pumpTotalizer && !showPumpForm && (
            <div className={`flex items-center justify-between rounded-lg border border-border-primary/50 bg-bg-input/30 ${compact ? "px-2 py-1" : "px-2.5 py-1.5"}`}>
              <div className="min-w-0">
                <p className="truncate text-[10px] font-bold uppercase tracking-wide text-text-muted">
                  {t("dispenser.totalizer")}
                  {pumpTotalizer.nozzleIndex != null ? ` · ${t("dispenser.nozzle")} ${pumpTotalizer.nozzleIndex}` : ""}
                </p>
                {pumpTotalizer.price != null && pumpTotalizer.price > 0 ? (
                  <p className="truncate text-xs text-text-tertiary">
                    {fmtSum.format(pumpTotalizer.price)} SUM/L
                  </p>
                ) : null}
              </div>
              <div className="shrink-0 text-right">
                <p className={`font-mono font-black tabular-nums text-text-secondary ${compact ? "text-xs" : "text-sm"}`}>
                  {pumpTotalizer.volume != null ? `${pumpTotalizer.volume.toFixed(2)} L` : "—"}
                </p>
                <p className={`font-mono tabular-nums text-text-muted ${compact ? "text-xs" : "text-sm"}`}>
                  {pumpTotalizer.amount != null ? fmtSum.format(pumpTotalizer.amount) : "—"}
                </p>
              </div>
            </div>
          )}
        </div>

        <div
          data-dispenser-action-zone="true"
          className={`flex shrink-0 flex-col justify-end ${compact ? "gap-1.5 pt-1" : "gap-2"}`}
          onClick={(e) => e.stopPropagation()}
        >
          {showPumpForm ? (
            shiftRequired ? (
              <div className={`flex flex-col items-center gap-1.5 rounded-lg border border-accent-amber/40 bg-accent-amber/10 px-2 ${compact ? "py-1.5" : "py-2"}`}>
                <p className={`text-center font-black uppercase tracking-wide text-accent-amber ${compact ? "text-xs" : "text-sm"}`}>
                  {t("dispenser.shiftRequired")}
                </p>
                {onStartShift && (
                  <button
                    type="button"
                    onClick={onStartShift}
                    className={`w-full rounded-lg bg-accent-amber font-black uppercase tracking-wide text-text-inverse hover:brightness-110 ${compact ? "py-2 text-xs" : "py-2.5 text-sm"}`}
                  >
                    {t("shiftWorkspace.startShift")}
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                data-dispenser-open-setup={!showInlinePumpForm ? "true" : undefined}
                disabled={showInlinePumpForm ? formStart.disabled : !positionActive}
                onClick={showInlinePumpForm ? formStart.onStart : () => setSetupOpen(true)}
                className={`btn-start-glow pump-start-button flex items-center justify-center gap-2 rounded-lg font-black uppercase tracking-wide leading-tight text-white transition disabled:cursor-not-allowed disabled:opacity-70 ${compact ? "py-3 text-base" : "py-4 text-lg"}`}
              >
                <InlineIcon src={playIcon} className={compact ? "h-5 w-5 shrink-0" : "h-6 w-6 shrink-0"} />
                {t("dispenser.start")}
              </button>
            )
          ) : isDelivering ? (
            <button
              type="button"
              data-no-keyboard="true"
              className={`flex w-full items-center justify-center gap-2 rounded-lg border font-black uppercase tracking-wide leading-tight ${
                useCancelMode
                  ? "border-accent-red/70 bg-accent-red/10 text-accent-red hover:bg-accent-red/20 hover:border-accent-red"
                  : "border-accent-amber/60 bg-accent-amber/10 text-accent-amber hover:bg-accent-amber/20 hover:border-accent-amber"
              } ${compact ? "py-3 text-base" : "py-4 text-lg"}`}
              onClick={() => useCancelMode ? onCancel?.(state.fp_id) : onStop(state.fp_id)}
            >
              <InlineIcon src={useCancelMode ? xCircleIcon : pauseIcon} className={compact ? "h-5 w-5 shrink-0" : "h-6 w-6 shrink-0"} />
              {useCancelMode ? t("dispenser.cancel") : useStopMode ? t("dispenser.stop") : t("dispenser.pause")}
            </button>
          ) : showNozzleRemovedBanner ? (
            <p className={`text-center font-semibold text-accent-amber-light ${compact ? "text-sm" : "text-sm"}`}>
              {t("dispenser.nozzleRemoved")}
            </p>
          ) : gilbarcoMode && isPaused && paused ? (
            <div className={`flex flex-col ${compact ? "gap-1.5" : "gap-3"}`}>
              {!compact && (
                <p className="text-center text-sm font-medium text-text-secondary">
                  {t("dispenser.fillPaused")}
                </p>
              )}
              <button
                type="button"
                className={`w-full rounded-xl bg-bg-secondary font-black uppercase tracking-wide leading-tight text-text-secondary ring-1 ring-border-primary hover:bg-bg-tertiary ${compact ? "py-2.5 text-base" : "px-4 py-4 text-base"}`}
                onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-1.5">
                  <InlineIcon src={xCircleIcon} className={`shrink-0 ${compact ? "h-4 w-4" : "h-5 w-5"}`} />
                  {t("dispenser.closeTransaction")}
                </span>
              </button>
            </div>
          ) : isAppStop && paused ? (
            <div className={`flex flex-col ${compact ? "gap-1.5" : "gap-3"}`}>
              {!compact && (
                <p className="text-center text-sm font-medium text-text-secondary">
                  {t("dispenser.holsterToFinish")}
                </p>
              )}
              <button
                type="button"
                className={`w-full rounded-lg py-2 text-center font-black uppercase leading-tight text-text-tertiary underline-offset-2 hover:bg-bg-secondary hover:text-text-secondary hover:underline ${compact ? "text-base" : "text-base"}`}
                onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-1">
                  <InlineIcon src={xCircleIcon} className={`shrink-0 ${compact ? "h-4 w-4" : "h-5 w-5"}`} />
                  {t("dispenser.closeTransaction")}
                </span>
              </button>
            </div>
          ) : isAppPause && paused ? (
            <div className={`flex flex-col ${compact ? "gap-1.5" : "gap-3"}`}>
              {!compact && (
                <>
                  <p className="text-center text-sm font-medium text-text-secondary">
                    {t("dispenser.hoseInTank")}
                  </p>
                  <p className="text-center text-xs text-text-tertiary">
                    {t("dispenser.partialSaved")}
                  </p>
                </>
              )}
              <button
                type="button"
                className={`btn-start-glow pump-start-button w-full rounded-lg font-black uppercase tracking-wide leading-tight text-white ${compact ? "py-3 text-base" : "py-4 text-lg"}`}
                onClick={() => onResumeFill(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-1.5">
                  <InlineIcon src={playIcon} className={`shrink-0 ${compact ? "h-5 w-5" : "h-6 w-6"}`} />
                  {t("dispenser.resumeFill")}
                </span>
              </button>
              <button
                type="button"
                className={`w-full rounded-lg py-2 text-center font-black uppercase leading-tight text-text-tertiary underline-offset-2 hover:bg-bg-secondary hover:text-text-secondary hover:underline ${compact ? "text-base" : "text-base"}`}
                onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-1">
                  <InlineIcon src={xCircleIcon} className={`shrink-0 ${compact ? "h-4 w-4" : "h-5 w-5"}`} />
                  {t("dispenser.closeTransaction")}
                </span>
              </button>
            </div>
          ) : isExternalPause && paused ? (
            <div className={`flex flex-col ${compact ? "gap-1.5" : "gap-3"}`}>
              {!compact && (
                <p className="text-center text-xs font-medium text-accent-amber-light/90">
                  {t("dispenser.fillPaused")}
                </p>
              )}
              <button
                type="button"
                className={`w-full rounded-xl bg-accent-emerald font-black uppercase leading-tight text-text-inverse shadow-lg hover:bg-accent-emerald-light active:scale-95 ${compact ? "py-3 text-base tracking-wide" : "px-4 py-5 text-xl tracking-wider"}`}
                onClick={() => onContinueFill(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-1.5">
                  <InlineIcon src={playIcon} className={`shrink-0 ${compact ? "h-5 w-5" : "h-7 w-7"}`} />
                  {t("dispenser.continueFill")}
                </span>
              </button>
              <button
                type="button"
                className={`w-full rounded-xl bg-bg-secondary font-black uppercase tracking-wide leading-tight text-text-secondary ring-1 ring-border-primary hover:bg-bg-tertiary ${compact ? "py-2.5 text-base" : "px-4 py-4 text-base"}`}
                onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-1.5">
                  <InlineIcon src={xCircleIcon} className={`shrink-0 ${compact ? "h-4 w-4" : "h-5 w-5"}`} />
                  {t("dispenser.closeTransaction")}
                </span>
              </button>
            </div>
          ) : hasActivePreAuth ? (
            <>
              {showPreAuthTimeoutBanner && (
                <p className="text-center text-xs font-medium text-accent-amber">
                  {t("dispenser.preAuthTimeout")}
                </p>
              )}
              <button
                type="button"
                data-no-keyboard="true"
                className={`w-full rounded-lg border border-border-primary bg-bg-secondary font-black uppercase tracking-wide leading-tight text-text-secondary hover:bg-bg-tertiary ${compact ? "py-3 text-base" : "py-3.5 text-base"}`}
                onClick={() => onCancelPreAuth?.(state.fp_id)}
              >
                <span className="flex items-center justify-center gap-1.5">
                  <InlineIcon src={banIcon} className="h-5 w-5 shrink-0" />
                  {t("dispenser.cancelPreAuth")}
                </span>
              </button>
            </>
          ) : showUnplannedLift ? (
            <p className="text-center text-xs font-semibold text-accent-red/80">
              {t("dispenser.replaceNozzle")}
            </p>
          ) : isContinuing && !isDelivering ? (
            <p className="text-center text-xs text-accent-blue/90">{t("dispenser.resumingFill")}</p>
          ) : isDone && !shouldAutoDismiss ? (
            <button
              type="button"
              className={`btn-start-glow w-full rounded-lg bg-accent-emerald font-black uppercase tracking-wide leading-tight text-text-inverse hover:bg-accent-emerald-light ${compact ? "py-3 text-base" : "py-4 text-lg"}`}
              onClick={() => onDismissSale?.(state.fp_id)}
            >
              {compact ? t("dispenser.nextCustomer") : t("dispenser.nextCustomerReady")}
            </button>
          ) : null}
        </div>
      </div>

      {useSetupModal && showPumpForm ? (
        <FillSetupModal
          open={setupOpen}
          state={state}
          fpNozzles={fpNozzles}
          mode={usePreAuth && !isNozzleUp ? "preauth" : "reactive"}
          initialNozzle={effectiveNozzle}
          onClose={() => setSetupOpen(false)}
          onConfirm={(req) => {
            setSetupOpen(false);
            handleFormStart(req);
          }}
        />
      ) : null}
    </>
  );
}
