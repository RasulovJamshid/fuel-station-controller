import { useEffect, useMemo, useRef, useState } from "react";
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
import { PumpCardForm, PumpCardProgress } from "./PumpCardForm";
import { PreAuthNozzleMismatchAlert } from "./PreAuthNozzleMismatchAlert";

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
      <span className="w-full truncate text-center text-[10px] font-bold uppercase tracking-wide text-text-muted">
        {label}
      </span>
      <span
        className={`w-full truncate text-center font-mono text-sm font-bold tabular-nums leading-none sm:text-base ${volumeClass}`}
      >
        {volume.toFixed(2)} L
      </span>
      <span
        className={`w-full truncate text-center font-mono text-xs tabular-nums leading-tight ${amountClass}`}
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

function preAuthLimitDisplay(preset: string | null | undefined): {
  kindLabel: string;
  value: string;
} {
  const raw = (preset ?? "Full tank").trim();
  const lower = raw.toLowerCase();
  if (lower === "full" || lower === "full tank") {
    return { kindLabel: "Fill mode", value: "Full tank" };
  }
  if (/\d/.test(raw) && (raw.includes(" L") || raw.endsWith("L") || lower.endsWith(" l"))) {
    return { kindLabel: "Volume limit", value: raw };
  }
  if (lower.includes("sum")) {
    return { kindLabel: "Amount limit", value: raw.replace(/\s*sum\s*/gi, " SUM") };
  }
  return { kindLabel: "Authorized limit", value: raw };
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
}: DispenserCardProps) {
  const [formStart, setFormStart] = useState<{ disabled: boolean; onStart: () => void }>({
    disabled: true,
    onStart: () => {},
  });
  const nozzleRemovedAt = useAppStore((s) => s.nozzleRemovedAt[state.fp_id]);
  const preAuthTimeoutFpId = useAppStore((s) => s.preAuthTimeoutFpId);
  const preAuthNozzleMismatch = useAppStore((s) => s.preAuthNozzleMismatch);
  const siteSnapshot = useAppStore((s) => s.siteSnapshot);
  const lastSaleOutcome = useAppStore((s) => s.lastSaleOutcome[state.fp_id]);
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
    const t = window.setTimeout(() => clearPreAuthNozzleMismatch(), 8000);
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
    const grade = productLabel ?? `Grade ${idx}`;
    return `Nozzle ${idx} · ${grade}`;
  }, [state.nozzle_index, effectiveNozzle, productLabel]);

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
    if (prevTagRef.current === "NOZZLE_UP" && tag === "IDLE") {
      setFormResetKey((k) => k + 1);
    }
    prevTagRef.current = tag;
  }, [tag]);
  const hasDeliveryPlan =
    state.pre_auth_preset != null && (isDelivering || isAuthorizing);
  const deliveryLimit = useMemo(
    () => preAuthLimitDisplay(state.pre_auth_preset),
    [state.pre_auth_preset],
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
  const cardMinH = compact ? "min-h-[420px]" : "min-h-[560px]";

  const statusHeader = useMemo(() => {
    const statusLabel = tag.replace(/_/g, " ");
    let subtitle = state.label;
    let rightMeta: string | null = null;

    if (isDelivering && hasDeliveryPlan) {
      subtitle = `${productLabel ?? "—"} · ${deliveryLimit.kindLabel}`;
      rightMeta = deliveryLimit.value;
    } else if (isDelivering) {
      subtitle = productLabel ? `${productLabel} — fueling` : "Delivering fuel";
    } else if (isAuthorizing && hasDeliveryPlan) {
      subtitle = `Authorizing · ${deliveryLimit.kindLabel}`;
      rightMeta = deliveryLimit.value;
    } else if (isDone && holsterEndedSale) {
      subtitle = "Nozzle holstered — partial sale closed";
      rightMeta = `${state.volume.toFixed(2)} L · ${fmtSum.format(state.amount)} SUM`;
    } else if (isDone && abortedSale) {
      subtitle = "Holstered before delivery started";
    } else if (isDone) {
      subtitle = "Sale complete — saved to shift";
      rightMeta = `${state.volume.toFixed(2)} L · ${fmtSum.format(state.amount)} SUM`;
    } else if (isExternalPause) {
      subtitle = "Lift nozzle to resume this fill";
    } else if (isAppPause) {
      subtitle = "Hose in tank — resume or close";
    } else if (hasActivePreAuth) {
      subtitle = isNozzleUp
        ? (liftedNozzleCaption ?? "Lift the authorized grade to start")
        : "Awaiting customer to lift nozzle";
    } else if (isNozzleUp) {
      subtitle = usePreAuth && !hasActivePreAuth
        ? "Cannot start — nozzle lifted without pre-authorization"
        : (liftedNozzleCaption ?? "Nozzle lifted");
    } else if (isIdle) {
      subtitle = usePreAuth
        ? "Holstered — ready to pre-authorize"
        : "Holstered — awaiting customer";
    } else if (isOffline) {
      subtitle = "Waiting for pump connection";
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

  return (
    <>
      <div
        className={`pump-card pump-card--${statusTone} ${cardMinH} relative flex w-full min-w-0 flex-col overflow-hidden rounded-xl border pt-4 ${compact ? "gap-2 px-3 pb-3" : "gap-3 px-4 pb-4"} ${
          isDelivering || (isNozzleUp && !showUnplannedLift) ? "ring-1 ring-accent-emerald/25" : showUnplannedLift ? "ring-1 ring-accent-red/30" : ""
        } ${showPreAuthMismatchBanner ? "ring-2 ring-accent-red/50" : ""} ${
          !positionActive ? "opacity-60 grayscale-[50%]" : ""
        }`}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <InlineIcon
              src={dispenserIcon}
              className={`shrink-0 ${compact ? "h-4 w-4" : "h-5 w-5"}`}
            />
            <h2
              className={`truncate font-bold uppercase tracking-wide text-text-primary ${compact ? "text-sm" : "text-base"}`}
            >
              {kolonkaTitle}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isNozzleUp && showPumpForm && (
              <span
                className="flex items-center gap-1 rounded-full bg-accent-emerald/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-emerald"
                title={liftedNozzleCaption ?? "Nozzle lifted"}
              >
                <InlineIcon src={dropletIcon} className="h-3 w-3" animated />
                {compact ? "" : "Nozzle up"}
              </span>
            )}
            {showUnplannedLift && (
              <span
                className="flex items-center gap-1 rounded-full bg-accent-red/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-red"
                title="Nozzle lifted without pre-authorization"
              >
                <InlineIcon src={dangerIcon} className="h-3 w-3" />
                {compact ? "" : "No pre-auth"}
              </span>
            )}
            <span
              className={`pump-auth-badge ${isIdle ? "pump-auth-badge--idle" : usePreAuth ? "pump-auth-badge--preauth" : "pump-auth-badge--reactive"}`}
              title={isIdle ? "Idle" : usePreAuth ? "Pre-authorize mode" : "Reactive mode"}
            >
              {isIdle ? "IDLE" : usePreAuth ? "PRE" : "R"}
            </span>
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${isOnline ? "bg-accent-emerald online-dot-glow" : "bg-text-muted"}`}
              title={isOnline ? "Online" : "Offline"}
              aria-label={isOnline ? "Online" : "Offline"}
            />
            <button
              type="button"
              onClick={onHide}
              className="shrink-0 text-text-muted opacity-40 hover:opacity-100 hover:text-text-secondary transition-opacity"
              title="Hide card"
            >
              <InlineIcon src={eyeOffIcon} className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 min-w-0 flex-col gap-2">
          {/* Status chip — always visible when idle, otherwise only when form is hidden */}
          {(!showPumpForm || isIdle) && !hasActivePreAuth && (
            <div
              className={`pump-status-chip flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${compact ? "text-[10px]" : "text-xs"}`}
            >
              <StatusIcon tag={tag} className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10px] font-bold uppercase tracking-wide text-text-muted">
                  {statusHeader.statusLabel}
                </p>
                <p className="truncate text-text-secondary">{statusHeader.subtitle}</p>
              </div>
              {statusHeader.rightMeta ? (
                <span className="shrink-0 font-mono tabular-nums text-text-muted">{statusHeader.rightMeta}</span>
              ) : null}
            </div>
          )}

          {showUnplannedLift && (
            <div className="rounded-lg border border-accent-red/40 bg-accent-red/10 px-3 py-3">
              <div className="flex items-start gap-2">
                <InlineIcon src={dangerIcon} className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-bold text-accent-red">Pre-authorization required</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-text-secondary">
                    Filling cannot start. Ask customer to replace the nozzle, then pre-authorize before lifting.
                  </p>
                </div>
              </div>
            </div>
          )}

          {hasActivePreAuth && !showPumpForm && (
            <div
              className="rounded-lg border border-accent-amber/40 bg-accent-amber/10 px-3 py-2"
              role="status"
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: productColor }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-primary">
                    {productLabel ?? "—"}
                  </p>
                  <p className="font-mono text-xs tabular-nums text-accent-amber">
                    {preAuthLimitDisplay(state.pre_auth_preset).value}
                  </p>
                </div>
              </div>
              <p className="mt-1 text-[10px] text-text-tertiary">
                {isNozzleUp ? "Lift nozzle to start" : "Awaiting customer nozzle"}
              </p>
            </div>
          )}

          {!showPumpForm && (
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-border-primary/60 bg-bg-input/45 px-2.5 py-1.5">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-text-muted">Grade</p>
                <p className="truncate text-xs font-semibold text-text-primary">{productLabel ?? "—"}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-text-muted">Nozzle</p>
                <p className="truncate text-xs font-semibold text-text-primary">{effectiveNozzle ?? "—"}</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wide text-text-muted">Price</p>
                <p className="truncate font-mono text-xs font-semibold tabular-nums text-accent-blue">
                  {displayPrice > 0 ? fmtSum.format(displayPrice) : "—"}
                </p>
              </div>
            </div>
          )}

          {showPumpForm ? (
            <div className="flex flex-1 min-w-0">
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

          {showPreAuthMismatchBanner && preAuthNozzleMismatch && (
            <PreAuthNozzleMismatchAlert
              expectedProductName={preAuthNozzleMismatch.expectedProductName}
              liftedProductName={preAuthNozzleMismatch.liftedProductName}
              expectedColor={preAuthNozzleMismatch.expectedColor}
              liftedColor={preAuthNozzleMismatch.liftedColor}
            />
          )}

          {isContinuing && !showPumpForm && (
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-border-primary bg-bg-input/50 p-2">
              <ContinuationMeterColumn
                label="Base"
                volume={state.base_volume ?? 0}
                amount={state.base_amount ?? 0}
              />
              <ContinuationMeterColumn
                label="+ Now"
                volume={state.segment_volume ?? 0}
                amount={state.segment_amount ?? 0}
                volumeClass="text-accent-emerald"
              />
              <ContinuationMeterColumn
                label="Total"
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
        </div>

        <div
          className="mt-auto flex shrink-0 flex-col justify-end gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          {showPumpForm ? (
            <button
              type="button"
              disabled={formStart.disabled}
              onClick={formStart.onStart}
              className={`btn-start-glow pump-start-button flex items-center justify-center gap-2 rounded-lg font-bold uppercase text-white transition disabled:cursor-not-allowed disabled:opacity-70 ${compact ? "py-2 text-xs" : "py-2.5 text-sm"}`}
            >
              <InlineIcon src={playIcon} className="h-4 w-4" />
              Start
            </button>
          ) : isDelivering ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled
                className={`btn-start-glow pump-start-button flex items-center justify-center gap-1.5 rounded-lg font-bold uppercase text-white/70 ${compact ? "py-2 text-xs" : "py-2.5 text-sm"}`}
              >
                <InlineIcon src={playIcon} className="h-4 w-4" />
                Start
              </button>
              <button
                type="button"
                title="Pause / stop fill"
                className={`flex items-center justify-center gap-1.5 rounded-lg border border-amber-900/50 bg-amber-950/40 font-bold uppercase text-accent-amber hover:bg-amber-950/60 ${compact ? "py-2 text-xs" : "py-2.5 text-sm"}`}
                onClick={() => onStop(state.fp_id)}
              >
                <InlineIcon src={pauseIcon} className="h-4 w-4" />
                Pauza
              </button>
            </div>
          ) : showNozzleRemovedBanner ? (
            <p className="text-center text-sm font-semibold text-accent-amber-light">
              Nozzle removed — fill closed
            </p>
          ) : isAppPause && paused ? (
            <div className={`flex flex-col ${compact ? "gap-1.5" : "gap-3"}`}>
              {!compact && (
                <>
                  <p className="text-center text-sm font-medium text-text-secondary">
                    Hose still in the customer&apos;s tank
                  </p>
                  <p className="text-center text-xs text-text-tertiary">
                    Partial fill saved. Resume without removing the nozzle.
                  </p>
                </>
              )}
              <button
                type="button"
                className={`btn-start-glow pump-start-button w-full rounded-lg py-2.5 font-bold uppercase text-white ${compact ? "text-xs" : "text-sm"}`}
                onClick={() => onResumeFill(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-2">
                  <InlineIcon src={playIcon} className={compact ? "h-4 w-4" : "h-5 w-5"} />
                  RESUME FILL
                </span>
              </button>
              <button
                type="button"
                className={`w-full text-center font-semibold text-text-tertiary underline-offset-2 hover:text-text-secondary hover:underline ${compact ? "text-[11px]" : "text-sm"}`}
                onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-1.5">
                  <InlineIcon src={xCircleIcon} className={compact ? "h-3 w-3" : "h-4 w-4"} />
                  Close transaction
                </span>
              </button>
            </div>
          ) : isExternalPause && paused ? (
            <div className={`flex flex-col ${compact ? "gap-1.5" : "gap-3"}`}>
              {!compact && (
                <p className="text-center text-xs font-medium text-accent-amber-light/90">
                  Fill paused — lift the nozzle, then continue the sale.
                </p>
              )}
              <button
                type="button"
                className={`w-full rounded-xl bg-accent-emerald font-black uppercase tracking-widest text-text-inverse shadow-lg hover:bg-accent-emerald-light active:scale-95 ${compact ? "py-2.5 text-sm" : "px-4 py-4 text-lg"}`}
                onClick={() => onContinueFill(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-2">
                  <InlineIcon src={playIcon} className={compact ? "h-4 w-4" : "h-5 w-5"} />
                  Continue fill
                </span>
              </button>
              <button
                type="button"
                className={`w-full rounded-xl bg-bg-secondary font-bold uppercase tracking-wider text-text-secondary ring-1 ring-border-primary hover:bg-bg-tertiary ${compact ? "py-1.5 text-xs" : "px-4 py-3 text-sm"}`}
                onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-2">
                  <InlineIcon src={xCircleIcon} className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
                  Close transaction
                </span>
              </button>
            </div>
          ) : hasActivePreAuth ? (
            <>
              {showPreAuthTimeoutBanner && (
                <p className="text-center text-xs font-medium text-accent-amber">
                  Pre-authorization timed out
                </p>
              )}
              <button
                type="button"
                className="w-full rounded-lg border border-border-primary bg-bg-secondary py-2 text-xs font-bold uppercase tracking-wide text-text-secondary hover:bg-bg-tertiary"
                onClick={() => onCancelPreAuth?.(state.fp_id)}
              >
                <span className="flex items-center justify-center gap-2">
                  <InlineIcon src={banIcon} className="h-4 w-4" />
                  Bekor qilish
                </span>
              </button>
            </>
          ) : showUnplannedLift ? (
            <p className="text-center text-xs font-semibold text-accent-red/80">
              Replace nozzle — then pre-authorize
            </p>
          ) : isContinuing && !isDelivering ? (
            <p className="text-center text-xs text-accent-blue/90">Resuming fill…</p>
          ) : isDone && !shouldAutoDismiss ? (
            <button
              type="button"
              className={`btn-start-glow w-full rounded-lg py-2.5 font-bold uppercase text-text-inverse bg-accent-emerald hover:bg-accent-emerald-light ${compact ? "text-xs" : "text-sm"}`}
              onClick={() => onDismissSale?.(state.fp_id)}
            >
              {compact ? "Keyingi mijoz" : "Keyingi mijozga tayyor"}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
