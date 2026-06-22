import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import banIcon       from "@/assets/icons/ban.svg";
import checkIcon     from "@/assets/icons/check.svg";
import dangerIcon    from "@/assets/icons/danger.svg";
import dispenserIcon from "@/assets/icons/dispenser.svg";
import dropletIcon   from "@/assets/icons/fuel.svg";
import loaderIcon    from "@/assets/icons/loader.svg";
import pauseIcon     from "@/assets/icons/pause.svg";
import playIcon      from "@/assets/icons/play.svg";
import powerIcon     from "@/assets/icons/power.svg";
import shieldIcon    from "@/assets/icons/shield.svg";
import wifiOffIcon   from "@/assets/icons/wifi-off.svg";
import xCircleIcon   from "@/assets/icons/x-circle.svg";
import { useAppStore } from "../store";
import { pausedInfo, statusTag } from "../types/api";
import type { FpStatus, FpStatusTag } from "../types/api";
import type { DispenserCardProps } from "./DispenserCard";
import { FillSetupModal } from "./FillSetupModal";
import { PreAuthNozzleMismatchAlert } from "./PreAuthNozzleMismatchAlert";

const fmtSum = new Intl.NumberFormat("uz-UZ");

function Icon({ src, className = "", spin = false }: { src: string; className?: string; spin?: boolean }) {
  return (
    <img src={src} alt="" aria-hidden draggable={false}
      className={`${className}${spin ? " animate-spin" : ""}`} />
  );
}

const STATUS_ICONS: Partial<Record<FpStatusTag, { src: string; spin?: boolean }>> = {
  DELIVERING:     { src: dropletIcon },
  PRE_AUTHORIZED: { src: shieldIcon },
  NOZZLE_UP:      { src: playIcon },
  AUTHORIZING:    { src: loaderIcon, spin: true },
  DONE:           { src: checkIcon },
  STOPPED:        { src: dangerIcon },
  OFFLINE:        { src: wifiOffIcon },
};

function parseVolumeTarget(preset: string | null | undefined): number | null {
  if (!preset) return null;
  const m = preset.match(/([\d.,]+)\s*L/i);
  const v = m ? Number.parseFloat(m[1].replace(",", ".")) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}
function parseAmountTarget(preset: string | null | undefined): number | null {
  if (!preset) return null;
  const m = preset.match(/([\d.,\s]+)\s*sum/i);
  const v = m ? Number.parseFloat(m[1].replace(/\s/g, "").replace(",", ".")) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function DispenserRow({
  state, fpNozzles, positionActive = true, defaultAuthMode = "reactive",
  onAuthorize, onPreAuthorize, onCancelPreAuth, onStop,
  onResumeFill, onContinueFill, onCloseStopped, onDismissSale,
  shiftRequired = false, onStartShift,
  useStopMode = false,
  gilbarcoMode = false,
}: DispenserCardProps) {
  const { t } = useTranslation();
  const [setupOpen, setSetupOpen] = useState(false);

  const nozzleRemovedAt       = useAppStore((s) => s.nozzleRemovedAt[state.fp_id]);
  const preAuthTimeoutFpId    = useAppStore((s) => s.preAuthTimeoutFpId);
  const preAuthNozzleMismatch = useAppStore((s) => s.preAuthNozzleMismatch);
  const siteSnapshot          = useAppStore((s) => s.siteSnapshot);
  const lastSaleOutcome       = useAppStore((s) => s.lastSaleOutcome[state.fp_id]);
  const clearNozzleRemoved    = useAppStore((s) => s.clearNozzleRemovedNotice);
  const clearPreAuthTimeout   = useAppStore((s) => s.clearPreAuthTimeoutNotice);
  const clearPreAuthMismatch  = useAppStore((s) => s.clearPreAuthNozzleMismatch);

  const showMismatch = preAuthNozzleMismatch != null && preAuthNozzleMismatch.fpId === state.fp_id;
  const showTimeout  = preAuthTimeoutFpId === state.fp_id;

  useEffect(() => {
    if (nozzleRemovedAt == null) return;
    const id = window.setTimeout(() => clearNozzleRemoved(state.fp_id), 6000);
    return () => window.clearTimeout(id);
  }, [nozzleRemovedAt, state.fp_id, clearNozzleRemoved]);

  useEffect(() => {
    if (!showTimeout) return;
    const id = window.setTimeout(() => clearPreAuthTimeout(), 5000);
    return () => window.clearTimeout(id);
  }, [showTimeout, clearPreAuthTimeout]);

  useEffect(() => {
    if (!showMismatch) return;
    const id = window.setTimeout(() => clearPreAuthMismatch(), 30000);
    return () => window.clearTimeout(id);
  }, [showMismatch, clearPreAuthMismatch]);

  const configuredNozzles = useMemo(() => {
    if (fpNozzles.length > 0) return fpNozzles;
    return siteSnapshot?.positions.find((p) => p.fp_id === state.fp_id)?.nozzles ?? [];
  }, [fpNozzles, siteSnapshot, state.fp_id]);

  const activeNozzles = useMemo(() => configuredNozzles.filter((n) => n.active), [configuredNozzles]);

  const effectiveNozzle =
    state.nozzle_index ?? (activeNozzles.length === 1 ? activeNozzles[0]!.index : null);

  const activeNozzle = useMemo(() => {
    if (effectiveNozzle != null) return configuredNozzles.find((n) => n.index === effectiveNozzle) ?? null;
    if (state.product_id != null) return configuredNozzles.find((n) => n.product_id === state.product_id) ?? null;
    return null;
  }, [configuredNozzles, effectiveNozzle, state.product_id]);

  const productLabel = state.product_name ?? activeNozzle?.product_name ?? null;
  const productColor = state.product_color ?? activeNozzle?.product_color ?? "#888";

  const tag             = statusTag(state.status as FpStatus);
  const paused          = pausedInfo(state);
  const isDelivering    = tag === "DELIVERING";
  const isDone          = tag === "DONE";
  const isIdle          = tag === "IDLE";
  const isNozzleUp      = tag === "NOZZLE_UP";
  const isAuthorizing   = tag === "AUTHORIZING";
  const isOffline       = tag === "OFFLINE";
  const isPaused        = paused != null;
  const isAppPause      = paused?.stop_source === "APP";
  const isAppStop       = paused?.stop_source === "APP_FINAL";
  const isExternalPause = paused?.stop_source === "EXTERNAL";
  const hasActivePreAuth =
    tag === "PRE_AUTHORIZED" ||
    (state.pre_auth_preset != null && tag !== "DONE" && tag !== "DELIVERING" && tag !== "AUTHORIZING" && tag !== "OFFLINE");
  const isContinuing = (state.base_volume ?? 0) > 0 && (isDelivering || isAuthorizing);
  const usePreAuth   = defaultAuthMode === "preauth";
  const isOnline     = !isOffline;

  const holsterEnded      = isDone && lastSaleOutcome === "holster_ended";
  const abortedSale       = isDone && lastSaleOutcome === "aborted";
  const shouldAutoDismiss = holsterEnded || abortedSale;
  const onDismissSaleRef  = useRef(onDismissSale);
  useEffect(() => { onDismissSaleRef.current = onDismissSale; });
  useEffect(() => {
    if (!shouldAutoDismiss) return;
    onDismissSaleRef.current?.(state.fp_id);
  }, [shouldAutoDismiss, state.fp_id]);

  const canOpenPreAuth  = (isIdle || isNozzleUp) && usePreAuth  && !isPaused && !isContinuing && !hasActivePreAuth;
  const canOpenReactive = isNozzleUp             && !usePreAuth && !isPaused && !isContinuing && !hasActivePreAuth;
  const canAuthorize    = positionActive && !isOffline && (canOpenPreAuth || canOpenReactive);

  const displayVolume = isPaused ? (paused?.stopped_volume ?? 0) : state.volume;
  const volTarget     = parseVolumeTarget(state.pre_auth_preset);
  const amtTarget     = parseAmountTarget(state.pre_auth_preset);
  const pct = volTarget && displayVolume > 0
    ? Math.min(100, (displayVolume / volTarget) * 100)
    : amtTarget && state.amount > 0
      ? Math.min(100, (state.amount / amtTarget) * 100)
      : null;

  const statusTone = isOffline ? "offline"
    : isDelivering     ? "delivering"
    : hasActivePreAuth ? "preauth"
    : isPaused         ? "paused"
    : isDone           ? "done"
    : isNozzleUp       ? "nozzle_up"
    : "idle";

  const accentBorder: Record<string, string> = {
    delivering: "border-l-accent-emerald",
    preauth:    "border-l-accent-amber",
    paused:     "border-l-accent-amber-dark",
    nozzle_up:  "border-l-accent-emerald",
    done:       "border-l-accent-blue",
    offline:    "border-l-border-secondary",
    idle:       "border-l-border-primary",
  };
  const bgTint: Record<string, string> = {
    delivering: "bg-accent-emerald/[0.04]",
    preauth:    "bg-accent-amber/[0.04]",
    paused:     "bg-accent-amber/[0.05]",
    nozzle_up:  "bg-accent-emerald/[0.03]",
    done:       "bg-accent-blue/[0.04]",
    offline: "", idle: "",
  };

  const kolonkaTitle =
    state.label?.trim() ||
    (state.fp_id.match(/\d+/) ? `${state.fp_id.match(/\d+/)![0]}-KOLONKA` : `${state.fp_id}-KOLONKA`);
  const pumpNum = state.fp_id.match(/\d+/)?.[0] ?? state.fp_id.slice(0, 2).toUpperCase();

  const handleAuthorize = (req: Parameters<typeof onAuthorize>[0]) => {
    if (!positionActive) return;
    if (canOpenPreAuth && !isNozzleUp) onPreAuthorize?.(req);
    else onAuthorize(req);
    setSetupOpen(false);
  };

  const statusIcon = STATUS_ICONS[tag] ?? { src: powerIcon };

  /* ── action buttons (icon-only — zone is too narrow for long labels) ──────── */
  const actionButton = (() => {
    if (canAuthorize && !isDone) {
      if (shiftRequired) {
        return (
          <button type="button" title={t("dispenser.shiftRequired")}
            onClick={onStartShift}
            className="flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-lg border border-accent-amber/50 bg-accent-amber/10 px-1 text-accent-amber hover:bg-accent-amber/20">
            <Icon src={shieldIcon} className="h-5 w-5 shrink-0" />
            <span className="text-center text-[9px] font-bold uppercase leading-tight">{t("dispenser.shiftRequired")}</span>
          </button>
        );
      }
      return (
        <button type="button" data-dispenser-open-setup="true" title={t("dispenser.start")} onClick={() => setSetupOpen(true)}
          className="btn-start-glow pump-start-button flex h-full w-full items-center justify-center rounded-lg text-white">
          <Icon src={playIcon} className="h-7 w-7" />
        </button>
      );
    }
    if (isDelivering) {
      return (
        <button type="button" data-no-keyboard="true" title={useStopMode ? t("dispenser.stop") : t("dispenser.pause")} onClick={() => onStop(state.fp_id)}
          className="flex h-full w-full items-center justify-center rounded-lg border border-amber-800/50 bg-amber-950/40 text-accent-amber hover:bg-amber-950/60">
          <Icon src={pauseIcon} className="h-7 w-7" />
        </button>
      );
    }
    if (hasActivePreAuth && !isDelivering && !isPaused) {
      return (
        <button type="button" data-no-keyboard="true" title={t("dispenser.cancelPreAuth")} onClick={() => onCancelPreAuth?.(state.fp_id)}
          className="flex h-full w-full items-center justify-center rounded-lg border border-border-primary bg-bg-secondary text-text-secondary hover:bg-bg-tertiary">
          <Icon src={banIcon} className="h-7 w-7" />
        </button>
      );
    }
    if (gilbarcoMode && isPaused && paused) {
      return (
        <div className="flex h-full w-full flex-col gap-1 py-1.5">
          <button type="button" title={t("dispenser.closeTransaction")} onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
            className="flex w-full flex-1 items-center justify-center rounded-md bg-bg-secondary text-text-secondary ring-1 ring-border-primary hover:bg-bg-tertiary">
            <Icon src={xCircleIcon} className="h-4 w-4" />
          </button>
        </div>
      );
    }
    if (isAppStop && paused) {
      return (
        <div className="flex h-full w-full flex-col gap-1 py-1.5">
          <button type="button" title={t("dispenser.closeTransaction")} onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
            className="flex w-full items-center justify-center rounded-md py-0.5 text-text-muted hover:text-text-secondary">
            <Icon src={xCircleIcon} className="h-4 w-4" />
          </button>
        </div>
      );
    }
    if (isAppPause && paused) {
      return (
        <div className="flex h-full w-full flex-col gap-1 py-1.5">
          <button type="button" title={t("dispenser.resumeFill")} onClick={() => onResumeFill(state.fp_id, paused.stopped_tx_id)}
            className="btn-start-glow pump-start-button flex flex-1 w-full items-center justify-center rounded-lg text-white">
            <Icon src={playIcon} className="h-6 w-6" />
          </button>
          <button type="button" title={t("dispenser.closeTransaction")} onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
            className="flex w-full items-center justify-center rounded-md py-0.5 text-text-muted hover:text-text-secondary">
            <Icon src={xCircleIcon} className="h-4 w-4" />
          </button>
        </div>
      );
    }
    if (isExternalPause && paused) {
      return (
        <div className="flex h-full w-full flex-col gap-1 py-1.5">
          <button type="button" title={t("dispenser.continueFill")} onClick={() => onContinueFill(state.fp_id, paused.stopped_tx_id)}
            className="flex flex-1 w-full items-center justify-center rounded-xl bg-accent-emerald text-text-inverse hover:bg-accent-emerald-light active:scale-95">
            <Icon src={playIcon} className="h-6 w-6" />
          </button>
          <button type="button" title={t("dispenser.closeTransaction")} onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
            className="flex w-full items-center justify-center rounded-md py-0.5 text-text-muted hover:text-text-secondary">
            <Icon src={xCircleIcon} className="h-4 w-4" />
          </button>
        </div>
      );
    }
    if (isDone && !shouldAutoDismiss) {
      return (
        <button type="button" title={t("dispenser.nextCustomer")} onClick={() => onDismissSale?.(state.fp_id)}
          className="btn-start-glow flex h-full w-full items-center justify-center rounded-lg bg-accent-emerald text-text-inverse hover:bg-accent-emerald-light">
          <Icon src={checkIcon} className="h-7 w-7" />
        </button>
      );
    }
    if (isAuthorizing && !isDelivering) {
      return <Icon src={loaderIcon} className="h-7 w-7 opacity-40" spin />;
    }
    if (isOffline) {
      return <Icon src={wifiOffIcon} className="h-6 w-6 opacity-30" />;
    }
    return null;
  })();

  /* ── render ─────────────────────────────────────────────────────────────── */
  return (
    <>
      <div className={[
        "w-full overflow-hidden rounded-xl border border-l-4 bg-bg-card transition-shadow",
        bgTint[statusTone] ?? "",
        accentBorder[statusTone],
        isDelivering ? "ring-1 ring-accent-emerald/20" : "",
        showMismatch  ? "ring-2 ring-accent-red/50"    : "",
        !positionActive ? "opacity-60 grayscale-[40%]" : "",
      ].filter(Boolean).join(" ")}>

        <div className="relative flex w-full items-stretch min-h-[88px] md:min-h-[90px]">

          {/* ══ LEFT ══ */}
          <div className="flex shrink-0 flex-col items-center justify-center py-2
                          w-20 gap-1.5
                          md:w-[152px] md:items-start md:gap-1.5 md:px-3">

            {/* mini */}
            <div className="flex flex-col items-center gap-1.5 md:hidden">
              <span className={`text-3xl font-black leading-none tabular-nums ${isOffline ? "text-text-muted" : "text-text-primary"}`}>
                {pumpNum}
              </span>
              <span className={`h-3 w-3 rounded-full ${isOnline ? "bg-accent-emerald online-dot-glow" : "bg-text-muted"}`} />
            </div>

            {/* full (md+) */}
            <div className="hidden md:flex items-center gap-1.5">
              <Icon src={dispenserIcon} className="h-4 w-4 shrink-0 opacity-55" />
              <span className="truncate text-base font-bold uppercase tracking-wide text-text-primary">{kolonkaTitle}</span>
            </div>
            <div className="hidden md:flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? "bg-accent-emerald online-dot-glow" : "bg-text-muted"}`}
                title={isOnline ? t("dispenser.online") : t("dispenser.offline")} />
              <span className={`pump-auth-badge ${isIdle ? "pump-auth-badge--idle" : usePreAuth ? "pump-auth-badge--preauth" : "pump-auth-badge--reactive"}`}>
                {isIdle ? t("dispenser.badgeIdle") : usePreAuth ? t("dispenser.badgePre") : t("dispenser.badgeR")}
              </span>
              {isNozzleUp && (
                <span className="flex items-center gap-0.5 rounded-full bg-accent-emerald/15 px-1 py-px text-[9px] font-bold uppercase text-accent-emerald">
                  <Icon src={dropletIcon} className="h-2.5 w-2.5" />
                  {t("dispenser.nozzleUpBadge")}
                </span>
              )}
              {nozzleRemovedAt != null && (
                <span className="rounded-full bg-accent-amber/15 px-1 py-px text-[9px] font-bold uppercase text-accent-amber">
                  {t("dispenser.nozzleOutBadge")}
                </span>
              )}
            </div>
          </div>

          <div className="w-px self-stretch bg-border-primary/30" />

          {/* ══ CENTER ══ */}
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-3 py-2 md:gap-1 md:px-4 md:py-2">

            {/* ── mini row 1: product + live volume ── */}
            <div className="flex min-w-0 items-center gap-2 md:hidden">
              {productLabel ? (
                <>
                  <span className="h-3 w-3 shrink-0 rounded-full border border-border-secondary/40" style={{ backgroundColor: productColor }} />
                  <span className="min-w-0 truncate text-base font-bold text-text-primary">{productLabel}</span>
                </>
              ) : (
                <span className="truncate text-base font-bold uppercase tracking-wide text-text-muted">{t(`dispenser.tag${tag.charAt(0) + tag.slice(1).toLowerCase().replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())}`, { defaultValue: tag.replace(/_/g, " ") })}</span>
              )}
              {(isDelivering || isPaused) && (
                <span className="ml-auto shrink-0 font-mono text-2xl font-black tabular-nums text-accent-emerald">{displayVolume.toFixed(2)} L</span>
              )}
              {hasActivePreAuth && !isDelivering && !isPaused && (
                <span className="ml-auto shrink-0 font-mono text-lg font-black tabular-nums text-accent-amber">{state.pre_auth_preset ?? t("pumpForm.fullTank")}</span>
              )}
              {isDone && !shouldAutoDismiss && (
                <span className="ml-auto shrink-0 font-mono text-xl font-black tabular-nums text-accent-blue">{state.volume.toFixed(2)} L</span>
              )}
            </div>

            {/* ── mini row 2: amount / progress / status ── */}
            <div className="flex min-w-0 items-center gap-2 md:hidden">
              {(isDelivering || isPaused) && (
                <>
                  <span className="font-mono text-base font-bold tabular-nums text-text-secondary">{fmtSum.format(state.amount)} SUM</span>
                  {pct !== null && (
                    <>
                      <div className="h-2.5 min-w-[48px] max-w-[100px] flex-1 overflow-hidden rounded-full">
                        <div className="progress-track h-full w-full overflow-hidden rounded-full">
                          <div className="progress-fill h-full rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <span className="font-mono text-base font-semibold tabular-nums text-text-muted">{Math.round(pct)}%</span>
                    </>
                  )}
                </>
              )}
              {isIdle && !hasActivePreAuth && (
                <span className="truncate text-base text-text-muted">{usePreAuth ? t("dispenser.statusIdlePreauth") : t("dispenser.statusIdle")}</span>
              )}
              {isNozzleUp && !hasActivePreAuth && (
                <span className="truncate text-base text-text-muted">{usePreAuth ? t("dispenser.statusNozzleUpPreauth") : t("dispenser.statusNozzleUp")}</span>
              )}
              {hasActivePreAuth && !isDelivering && (
                <span className="truncate text-base font-semibold text-text-secondary">{isNozzleUp ? t("dispenser.preAuthAwaitingLift") : t("dispenser.preAuthAwaitingCustomer")}</span>
              )}
              {isDone && !shouldAutoDismiss && (
                <span className="truncate text-base font-bold tabular-nums text-accent-blue">{fmtSum.format(state.amount)} SUM</span>
              )}
              {isOffline && <span className="text-base text-text-muted">{t("dispenser.statusOffline")}</span>}
              {showMismatch && <span className="ml-auto shrink-0 text-sm font-bold uppercase text-accent-red">⚠ {t("dispenser.mismatchShort")}</span>}
            </div>

            {/* ── full row 1: tag + product + nozzle + price ── */}
            <div className="hidden md:flex min-w-0 items-center gap-2">
              <Icon src={statusIcon.src} className="h-4 w-4 shrink-0 opacity-55" spin={statusIcon.spin} />
              <span className="text-sm font-bold uppercase tracking-wider text-text-muted">{t(`dispenser.tag${tag.charAt(0) + tag.slice(1).toLowerCase().replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())}`, { defaultValue: tag.replace(/_/g, " ") })}</span>
              {productLabel && (
                <>
                  <span className="text-border-primary">·</span>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-border-secondary/40" style={{ backgroundColor: productColor }} />
                  <span className="min-w-0 truncate text-sm font-semibold text-text-primary">{productLabel}</span>
                </>
              )}
              {effectiveNozzle != null && !isOffline && (
                <span className="shrink-0 rounded bg-bg-secondary px-1 py-px text-[10px] font-bold uppercase text-text-muted">#{effectiveNozzle}</span>
              )}
              {state.price > 0 && !isOffline && !isIdle && (
                <span className="ml-auto shrink-0 font-mono text-sm font-bold tabular-nums text-accent-blue">{fmtSum.format(state.price)}/L</span>
              )}
            </div>

            {/* ── full row 2: live data / status ── */}
            <div className="hidden md:flex min-w-0 items-center gap-2 text-base">
              {(isDelivering || isPaused) && (
                <>
                  <span className={`shrink-0 font-mono font-bold tabular-nums ${isDelivering ? "text-accent-emerald" : "text-accent-amber-light"}`}>{displayVolume.toFixed(2)} L</span>
                  <span className="text-border-primary">·</span>
                  <span className="shrink-0 font-mono tabular-nums text-text-secondary">{fmtSum.format(state.amount)} SUM</span>
                  {pct !== null && (
                    <>
                      <span className="text-border-primary">·</span>
                      <div className="h-2 min-w-[60px] max-w-[140px] flex-1 overflow-hidden rounded-full">
                        <div className="progress-track h-full w-full overflow-hidden rounded-full">
                          <div className="progress-fill h-full rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <span className="shrink-0 font-mono tabular-nums text-text-muted">{Math.round(pct)}%</span>
                    </>
                  )}
                  {isContinuing && <span className="ml-1 shrink-0 rounded bg-accent-blue/10 px-1 py-px text-[10px] font-bold uppercase text-accent-blue">{t("dispenser.baseBadge")}</span>}
                </>
              )}
              {hasActivePreAuth && !isDelivering && !isPaused && (
                <>
                  <span className="shrink-0 font-mono tabular-nums text-accent-amber">{state.pre_auth_preset ?? t("pumpForm.fullTank")}</span>
                  <span className="text-border-primary">·</span>
                  <span className="truncate text-text-muted">{isNozzleUp ? t("dispenser.preAuthAwaitingLift") : t("dispenser.preAuthAwaitingCustomer")}</span>
                  {showTimeout && <span className="ml-1 shrink-0 rounded bg-accent-amber/10 px-1 py-px text-[10px] font-bold text-accent-amber">{t("dispenser.timeoutBadge")}</span>}
                </>
              )}
              {isDone && !shouldAutoDismiss && (
                <>
                  <span className="shrink-0 font-bold text-text-primary">{state.volume.toFixed(2)} L</span>
                  <span className="text-border-primary">·</span>
                  <span className="shrink-0 font-mono tabular-nums text-accent-blue">{fmtSum.format(state.amount)} SUM</span>
                  <span className="text-border-primary">·</span>
                  <span className="truncate text-text-muted">{t("dispenser.statusDone")}</span>
                </>
              )}
              {isIdle && !hasActivePreAuth && <span className="truncate text-text-muted">{usePreAuth ? t("dispenser.statusIdlePreauth") : t("dispenser.statusIdle")}</span>}
              {isNozzleUp && !hasActivePreAuth && !isDelivering && !isPaused && <span className="truncate text-text-muted">{usePreAuth ? t("dispenser.statusNozzleUpPreauth") : t("dispenser.statusNozzleUp")}</span>}
              {isAppPause      && !isDelivering && <span className="truncate text-accent-amber-light">{t("dispenser.statusAppPause")}</span>}
              {isExternalPause && !isDelivering && <span className="truncate text-accent-amber">{t("dispenser.statusExternalPause")}</span>}
              {isOffline && <span className="text-text-muted">{t("dispenser.statusOffline")}</span>}
              {showMismatch && preAuthNozzleMismatch && (
                <span className="ml-auto shrink-0 rounded bg-accent-red/10 px-1.5 py-px text-[10px] font-bold uppercase text-accent-red">⚠ {t("dispenser.mismatchShort")}</span>
              )}
            </div>
          </div>

          <div className="w-px self-stretch bg-border-primary/30" />

          {/* ══ RIGHT: action zone ══ */}
          <div data-dispenser-action-zone="true"
            className="flex shrink-0 items-center justify-center w-20 px-1.5 py-1.5 md:w-[152px] md:px-3 md:py-2">
            {actionButton}
          </div>
        </div>
        {showMismatch && preAuthNozzleMismatch && (
          <div className="border-t border-red-600/40 p-2">
            <PreAuthNozzleMismatchAlert
              expectedProductName={preAuthNozzleMismatch.expectedProductName}
              liftedProductName={preAuthNozzleMismatch.liftedProductName}
              expectedColor={preAuthNozzleMismatch.expectedColor}
              liftedColor={preAuthNozzleMismatch.liftedColor}
              onClose={clearPreAuthMismatch}
            />
          </div>
        )}
      </div>

      <FillSetupModal
        open={setupOpen}
        state={state}
        fpNozzles={fpNozzles}
        mode={usePreAuth && !isNozzleUp ? "preauth" : "reactive"}
        initialNozzle={effectiveNozzle}
        onClose={() => setSetupOpen(false)}
        onConfirm={handleAuthorize}
      />
    </>
  );
}
