import { useEffect, useMemo, useState } from "react";
import {
  Droplets,
  ShieldCheck,
  Fuel,
  Loader2,
  CheckCircle2,
  AlertOctagon,
  WifiOff,
  Power,
  Play,
  XCircle,
  Ban,
} from "lucide-react";
import type { AuthMode, FpState, FpStatus, FpStatusTag, NozzleSnapshot } from "../types/api";
import { pausedInfo, statusTag } from "../types/api";
import { useAppStore } from "../store";
import { AuthorizeModal } from "./AuthorizeModal";
import { PreAuthNozzleMismatchAlert } from "./PreAuthNozzleMismatchAlert";

export type FillMode = "full" | "volume" | "amount";

const fmtSum = new Intl.NumberFormat("uz-UZ");

function meterAmountTextClass(formatted: string, delivering: boolean): string {
  const len = formatted.length;
  if (len > 14) return delivering ? "text-sm leading-snug" : "text-sm leading-snug";
  if (len > 10) return delivering ? "text-base leading-snug" : "text-base leading-snug";
  if (len > 7) return delivering ? "text-lg leading-snug" : "text-lg leading-snug";
  return delivering ? "text-xl leading-none" : "text-lg leading-none";
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

function formatPricePerLiter(price: number): string {
  if (price <= 0) return "—";
  return `${fmtSum.format(price)} SUM/L`;
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

function badgeClass(status: FpStatusTag) {
  switch (status) {
    case "DELIVERING":
      return "border-accent-emerald/50 bg-accent-emerald/15 text-accent-emerald-light ring-1 ring-accent-emerald/30";
    case "PRE_AUTHORIZED":
      return "border-accent-amber/50 bg-accent-amber/15 text-accent-amber-light ring-1 ring-accent-amber/35";
    case "NOZZLE_UP":
    case "AUTHORIZING":
      return "border-accent-emerald/45 bg-accent-emerald/12 text-accent-emerald-light ring-1 ring-accent-emerald/25";
    case "DONE":
      return "border-accent-blue/50 bg-accent-blue/15 text-accent-blue ring-1 ring-accent-blue/30";
    case "STOPPED":
      return "border-accent-red/50 bg-accent-red/15 text-accent-red-light ring-1 ring-accent-red/30";
    case "OFFLINE":
      return "border-text-muted/50 bg-bg-tertiary/40 text-text-tertiary ring-1 ring-border-primary/40";
    default:
      return "border-border-primary/50 bg-bg-secondary/60 text-text-tertiary ring-1 ring-border-primary/35";
  }
}

function StatusIcon({ tag, className = "" }: { tag: FpStatusTag; className?: string }) {
  switch (tag) {
    case "DELIVERING":
      return <Droplets className={`animate-pulse ${className}`} />;
    case "PRE_AUTHORIZED":
      return <ShieldCheck className={className} />;
    case "NOZZLE_UP":
      return <Fuel className={className} />;
    case "AUTHORIZING":
      return <Loader2 className={`animate-spin ${className}`} />;
    case "DONE":
      return <CheckCircle2 className={className} />;
    case "STOPPED":
      return <AlertOctagon className={className} />;
    case "OFFLINE":
      return <WifiOff className={className} />;
    default:
      return <Power className={className} />;
  }
}

function statusAccentBar(status: FpStatusTag) {
  switch (status) {
    case "DELIVERING":
    case "NOZZLE_UP":
    case "AUTHORIZING":
      return "from-accent-emerald-light via-accent-emerald to-accent-emerald-dark";
    case "PRE_AUTHORIZED":
      return "from-accent-amber-light via-accent-amber to-accent-amber-dark";
    case "DONE":
      return "from-accent-blue via-accent-blue to-blue-600";
    case "STOPPED":
      return "from-accent-red-light via-accent-red to-accent-red-dark";
    case "OFFLINE":
      return "from-text-muted via-border-primary to-border-secondary";
    default:
      return "from-border-primary via-border-secondary to-bg-tertiary";
  }
}

function statusHeaderSurface(status: FpStatusTag) {
  switch (status) {
    case "DELIVERING":
    case "NOZZLE_UP":
    case "AUTHORIZING":
      return "border-accent-emerald/25 bg-gradient-to-br from-accent-emerald-dark/20 via-bg-primary/95 to-bg-primary";
    case "PRE_AUTHORIZED":
      return "border-accent-amber/30 bg-gradient-to-br from-accent-amber-dark/15 via-bg-primary/95 to-bg-primary";
    case "DONE":
      return "border-accent-blue/25 bg-gradient-to-br from-accent-blue/15 via-bg-primary/95 to-bg-primary";
    case "STOPPED":
      return "border-accent-red/25 bg-gradient-to-br from-accent-red-dark/15 via-bg-primary/95 to-bg-primary";
    case "OFFLINE":
      return "border-border-primary/40 bg-gradient-to-br from-bg-secondary via-bg-primary to-bg-primary";
    default:
      return "border-border-secondary/50 bg-gradient-to-br from-bg-secondary/90 via-bg-primary to-bg-primary";
  }
}

function cardShellClass(status: FpStatusTag) {
  switch (status) {
    case "DELIVERING":
      return "border-accent-emerald bg-accent-emerald/10 shadow-accent-emerald/20";
    case "PRE_AUTHORIZED":
      return "border-accent-amber bg-accent-amber/15 shadow-lg shadow-accent-amber/30 ring-2 ring-accent-amber/25";
    case "NOZZLE_UP":
    case "AUTHORIZING":
      return "border-accent-emerald bg-accent-emerald/10 shadow-accent-emerald/25 ring-2 ring-accent-emerald/40";
    case "DONE":
      return "border-accent-blue bg-accent-blue/10 shadow-accent-blue/20";
    case "STOPPED":
      return "border-accent-red bg-accent-red/10";
    case "OFFLINE":
      return "border-accent-red-light/60 bg-bg-secondary/80 opacity-70";
    default:
      return "border-border-primary bg-bg-card/80";
  }
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
  onAuthorize,
  onPreAuthorize,
  onCancelPreAuth,
  onStop,
  onResumeFill,
  onContinueFill,
  onCloseStopped,
  onDismissSale,
}: DispenserCardProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"preauth" | "reactive">("preauth");
  const [modalNozzleHint, setModalNozzleHint] = useState<number | null>(null);
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
  const hasDeliveryPlan =
    state.pre_auth_preset != null && (isDelivering || isAuthorizing);
  const deliveryLimit = useMemo(
    () => preAuthLimitDisplay(state.pre_auth_preset),
    [state.pre_auth_preset],
  );
  const isNozzleUpOrAuth = isNozzleUp || isAuthorizing;
  const isDone = tag === "DONE";
  const holsterEndedSale = isDone && lastSaleOutcome === "holster_ended";
  const abortedSale = isDone && lastSaleOutcome === "aborted";
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
  const canOpenPreAuthSetup = isIdle && usePreAuth && !isPaused && !isContinuing;
  const canOpenReactiveSetup =
    isNozzleUp && !isPaused && !isContinuing && !hasActivePreAuth;
  const isOffline = tag === "OFFLINE";
  const hasMultipleProducts = activeNozzles.length > 1;
  const showProductBanner =
    positionActive &&
    productLabel != null &&
    !canOpenPreAuthSetup &&
    !hasActivePreAuth &&
    !(canOpenReactiveSetup && state.product_name == null);

  const openPreAuthSetup = () => {
    if (!canOpenPreAuthSetup || !positionActive) return;
    setModalMode("preauth");
    setModalNozzleHint(activeNozzles.length === 1 ? (activeNozzles[0]?.index ?? null) : null);
    setModalOpen(true);
  };

  const openReactiveSetup = (nozzleIndex?: number) => {
    if (!canOpenReactiveSetup || !positionActive) return;
    setModalMode("reactive");
    setModalNozzleHint(nozzleIndex ?? null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalNozzleHint(null);
  };

  const handleModalConfirm = (req: AuthorizeRequest) => {
    if (modalMode === "preauth") onPreAuthorize?.(req);
    else onAuthorize(req);
  };

  useEffect(() => {
    if (!modalOpen) return;
    if (
      (modalMode === "preauth" && !canOpenPreAuthSetup) ||
      (modalMode === "reactive" && !canOpenReactiveSetup)
    ) {
      setModalOpen(false);
      setModalNozzleHint(null);
    }
  }, [modalOpen, modalMode, canOpenPreAuthSetup, canOpenReactiveSetup]);

  const p = compact ? "p-3" : "p-5";
  const cardMinH = compact ? "min-h-[18rem]" : "min-h-[26rem]";
  const primaryBtnH = compact ? "min-h-[2.5rem]" : "min-h-[3rem]";
  const headerBleed = compact ? "-mx-3 -mt-3 mb-2" : "-mx-5 -mt-5 mb-3";

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
        ? "Lift the authorized grade to start"
        : "Awaiting customer to lift nozzle";
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
  ]);

  return (
    <>
      <div
        className={`relative flex h-full min-h-0 flex-col rounded-md border-2 shadow-lg transition-colors duration-300 hover:shadow-xl ${cardMinH} ${p} ${cardShellClass(tag)} ${
          showPreAuthMismatchBanner ? "ring-4 ring-red-500/50 ring-offset-2 ring-offset-slate-900" : ""
        } ${!positionActive ? "opacity-60 grayscale-[50%]" : ""}`}
      >
        <header
          className={`shrink-0 overflow-hidden rounded-t-sm border-b ${statusHeaderSurface(tag)} ${headerBleed}`}
        >
          <div
            className={`w-full ${compact ? "h-1" : "h-2"} bg-gradient-to-r ${statusAccentBar(tag)}`}
            aria-hidden
          />
          <div
            className={`flex min-w-0 items-start justify-between gap-3 ${compact ? "px-2.5 py-2" : "px-3.5 py-3"}`}
          >
            <div className="min-w-0 flex-1">
              <p
                className={`font-semibold uppercase tracking-[0.14em] text-text-muted ${compact ? "text-[8px]" : "text-[9px]"}`}
              >
                {state.label || "Fuel position"}
              </p>
              <h2
                className={`mt-0.5 truncate font-black tracking-tight text-text-primary ${compact ? "text-lg leading-tight" : "text-2xl leading-none"}`}
              >
                Pump {state.fp_id}
              </h2>
              <p
                className={`mt-1 text-text-tertiary ${compact ? "line-clamp-1 text-[10px] leading-snug" : "line-clamp-2 text-xs leading-snug"}`}
              >
                {!positionActive ? (
                  <span className="font-medium text-text-muted">Inactive · </span>
                ) : null}
                {statusHeader.subtitle}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <span
                className={`inline-flex items-center gap-1 rounded-full border font-bold uppercase tracking-wide ${compact ? "px-2 py-0.5 text-[8px]" : "px-2.5 py-1 text-[10px]"} ${badgeClass(tag)}`}
                aria-label={`Status: ${statusHeader.statusLabel}`}
                title={statusHeader.statusLabel}
              >
                <StatusIcon tag={tag} className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
                {statusHeader.statusLabel}
              </span>
              {statusHeader.rightMeta ? (
                <span
                  className={`max-w-[9rem] rounded-md border border-border-primary bg-bg-secondary px-2 py-0.5 text-right font-mono font-semibold tabular-nums leading-tight text-text-primary ${compact ? "text-[9px]" : "text-[11px]"}`}
                >
                  {statusHeader.rightMeta}
                </span>
              ) : null}
            </div>
          </div>
        </header>
        {hasActivePreAuth && !showPreAuthMismatchBanner && (
          <div className={`shrink-0 w-full ${compact ? "mb-2" : "mb-3"}`}>{(
              <div
                className="w-full overflow-hidden rounded-md border-2 border-amber-500 bg-amber-950/40"
                role="status"
              >
                <div
                  className="h-1.5 w-full"
                  style={{ backgroundColor: productColor }}
                  aria-hidden
                />
                <div className={compact ? "px-2.5 py-2" : "px-4 py-3"}>
                  {(() => {
                    const limit = preAuthLimitDisplay(state.pre_auth_preset);
                    return (
                      <>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p
                              className={`font-bold uppercase tracking-wider text-amber-400/90 ${compact ? "text-[9px]" : "text-[10px]"}`}
                            >
                              Authorized product
                            </p>
                            <p
                              className={`truncate font-black leading-tight text-text-primary ${compact ? "text-sm" : "text-lg"}`}
                            >
                              {productLabel ?? "—"}
                            </p>
                            {effectiveNozzle != null && (
                              <p
                                className={`mt-0.5 font-medium text-amber-300/80 ${compact ? "text-[9px]" : "text-[10px]"}`}
                              >
                                Nozzle {effectiveNozzle}
                              </p>
                            )}
                          </div>
                          <div className="shrink-0 border-l border-amber-500/40 pl-3 text-right">
                            <p
                              className={`font-bold uppercase tracking-wider text-amber-400/90 ${compact ? "text-[9px]" : "text-[10px]"}`}
                            >
                              Rate
                            </p>
                            <p
                              className={`font-mono font-bold tabular-nums text-amber-300 ${compact ? "text-[10px]" : "text-xs"}`}
                            >
                              {formatPricePerLiter(displayPrice)}
                            </p>
                          </div>
                        </div>
                        <div
                          className={`mt-2 rounded-md border border-amber-500/35 bg-amber-950/55 text-center ${compact ? "px-2 py-2" : "px-3 py-3"}`}
                        >
                          <p
                            className={`font-bold uppercase tracking-widest text-amber-400/90 ${compact ? "text-[9px]" : "text-[10px]"}`}
                          >
                            {limit.kindLabel}
                          </p>
                          <p
                            className={`mt-0.5 font-mono font-black tabular-nums leading-none tracking-tight text-amber-300 drop-shadow-[0_0_12px_rgba(252,211,77,0.25)] ${compact ? "text-2xl" : "text-4xl"}`}
                          >
                            {limit.value}
                          </p>
                        </div>
                      </>
                    );
                  })()}
                </div>
                <div
                  className={`flex items-center gap-2 border-t border-amber-500/40 bg-amber-950/50 ${compact ? "px-2.5 py-1.5" : "px-4 py-2"}`}
                >
                  <Fuel
                    className={`shrink-0 text-amber-300 ${compact ? "h-4 w-4" : "h-5 w-5"}`}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p
                      className={`font-bold uppercase leading-tight tracking-wide text-amber-100 ${compact ? "text-[10px]" : "text-xs"}`}
                    >
                      {isNozzleUp
                        ? compact
                          ? "Lift correct grade to start"
                          : "Lift the authorized grade to start"
                        : compact
                          ? "Awaiting customer nozzle"
                          : "Awaiting customer to lift nozzle"}
                    </p>
                    <p
                      className={`text-amber-200/80 ${compact ? "text-[9px]" : "text-[11px]"}`}
                    >
                      {isNozzleUp
                        ? "Ready when the correct nozzle is lifted"
                        : "Holstered — lift nozzle when customer is ready"}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {showProductBanner && (
          <div className={`shrink-0 overflow-hidden rounded-md border-2 border-border-primary bg-bg-meter shadow-sm ${compact ? "mb-2" : "mb-4"}`}>
            <div 
              className="h-2 w-full border-b border-border-primary" 
              style={{ 
                backgroundColor: productColor,
                borderTop: `3px solid ${productColor}`
              }} 
            />
            <div className={`flex items-center justify-between gap-3 ${compact ? "px-3 py-2" : "px-5 py-4"}`}>
              <div className="min-w-0">
                {!compact && (
                  <div className="text-xs font-bold uppercase tracking-wider text-text-muted mb-1">PRODUCT GRADE</div>
                )}
                <div className={`truncate font-bold text-text-primary transition-colors ${compact ? "text-sm" : "text-base"}`}>
                  {productLabel ?? "—"}
                </div>
                {!compact && (
                  <div className="mt-1 text-xs font-medium text-text-tertiary">
                    FUEL TYPE
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right border-l border-border-primary pl-4">
                {!compact && (
                  <div className="text-xs font-bold uppercase tracking-wider text-text-muted mb-1">RATE</div>
                )}
                <div className={`font-mono font-bold text-accent-amber tabular-nums ${compact ? "text-sm" : "text-base"}`}>
                  {formatPricePerLiter(displayPrice)}
                </div>
                {!compact && (
                  <div className="mt-1 text-xs font-medium text-text-tertiary">
                    PRICE PER LITER
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div
          className={`min-w-0 shrink-0 overflow-hidden rounded-md border-2 bg-bg-meter ${compact ? "mb-2 p-3" : "mb-4 p-5"} ${
            isDelivering
              ? "border-accent-emerald bg-accent-emerald/10"
              : hasActivePreAuth
                ? "border-accent-amber bg-accent-amber/10"
                : isPaused
                  ? "border-accent-red bg-accent-red/10"
                  : "border-border-primary"
          }`}
        >
          {isContinuing && (
            <div className="mb-1 grid min-w-0 grid-cols-3 gap-1">
              <ContinuationMeterColumn
                label="Base"
                volume={state.base_volume ?? 0}
                amount={state.base_amount ?? 0}
              />
              <ContinuationMeterColumn
                label="+ Current"
                volume={state.segment_volume ?? 0}
                amount={state.segment_amount ?? 0}
                volumeClass="text-accent-emerald"
              />
              <ContinuationMeterColumn
                label="= Total"
                volume={state.volume}
                amount={state.amount}
                volumeClass="text-text-primary"
                amountClass="text-accent-blue"
              />
            </div>
          )}
          {!isContinuing && (
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <div className="min-w-0">
                <p className="mb-1 text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-2">
                  <div className="w-2 h-2 bg-accent-emerald rounded-full border border-accent-emerald-light"></div>
                  VOLUME
                </p>
                <p
                  className={`flex min-w-0 items-baseline gap-1 font-mono font-bold tabular-nums text-text-primary ${
                    isDelivering
                      ? `animate-pulse ${compact ? "text-lg leading-none" : "text-2xl leading-none"}`
                      : compact
                        ? "text-lg leading-none"
                        : "text-2xl leading-none"
                  }`}
                >
                  <span className="min-w-0 truncate">
                    {(isPaused ? paused.stopped_volume : state.volume).toFixed(2)}
                  </span>
                  <span className={`shrink-0 font-semibold text-text-tertiary ${compact ? "text-sm" : "text-base"}`}>L</span>
                </p>
                {!compact && (
                  <p className="mt-2 text-xs font-medium text-text-tertiary border-t border-border-primary pt-2">
                    LITERS DISPENSED
                  </p>
                )}
              </div>
              <div className="min-w-0 text-right">
                <p className="mb-1 text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-2 justify-end">
                  <div className="w-2 h-2 bg-accent-blue rounded-full border border-blue-300"></div>
                  AMOUNT
                </p>
                <p
                  className={`flex min-w-0 flex-wrap items-baseline justify-end gap-x-1 font-mono font-bold tabular-nums text-accent-blue ${
                    isDelivering
                      ? `animate-pulse ${meterAmountTextClass(
                          fmtSum.format(isPaused ? paused.stopped_amount : state.amount),
                          true,
                        )}`
                      : meterAmountTextClass(
                          fmtSum.format(isPaused ? paused.stopped_amount : state.amount),
                          false,
                        )
                  }`}
                >
                  <span className="min-w-0 break-all">
                    {fmtSum.format(isPaused ? paused.stopped_amount : state.amount)}
                  </span>
                  <span className="shrink-0 text-xs font-semibold text-text-tertiary">SUM</span>
                </p>
                {!compact && (
                  <p className="mt-2 text-xs font-medium text-text-tertiary border-t border-border-primary pt-2">
                    TOTAL COST
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div
          className={`mt-auto flex shrink-0 flex-col justify-end ${compact ? "min-h-[3.25rem]" : "min-h-[4.5rem]"}`}
          onClick={(e) => e.stopPropagation()}
        >
          {isDelivering ? (
            <button
              type="button"
              title="Emergency Stop"
              className={`flex w-full flex-col items-center justify-center rounded-md bg-accent-red font-black tracking-widest text-text-inverse border-2 border-accent-red-dark transition-all duration-200 hover:bg-accent-red-light hover:border-accent-red active:bg-accent-red-dark active:border-accent-red-dark ${primaryBtnH} ${compact ? "text-sm" : "text-lg"}`}
              onClick={() => onStop(state.fp_id)}
            >
              {!compact && <span className="mb-1 text-2xl">⚠️</span>}
              {compact ? "STOP" : "EMERGENCY STOP"}
            </button>
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
                className={`w-full rounded-md bg-accent-emerald font-black uppercase tracking-widest text-text-inverse border-2 border-accent-emerald-dark transition-all duration-200 hover:bg-accent-emerald-light hover:border-accent-emerald active:bg-accent-emerald-dark active:border-accent-emerald-dark ${primaryBtnH} ${compact ? "text-sm" : "text-lg"}`}
                onClick={() => onResumeFill(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-2">
                  <Play className={compact ? "h-4 w-4" : "h-5 w-5"} />
                  RESUME FILL
                </span>
              </button>
              <button
                type="button"
                className={`w-full text-center font-semibold text-text-tertiary underline-offset-2 hover:text-text-secondary hover:underline ${compact ? "text-[11px]" : "text-sm"}`}
                onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-1.5">
                  <XCircle className={compact ? "h-3 w-3" : "h-4 w-4"} />
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
                  <Play className={compact ? "h-4 w-4" : "h-5 w-5"} />
                  Continue fill
                </span>
              </button>
              <button
                type="button"
                className={`w-full rounded-xl bg-bg-secondary font-bold uppercase tracking-wider text-text-secondary ring-1 ring-border-primary hover:bg-bg-tertiary ${compact ? "py-1.5 text-xs" : "px-4 py-3 text-sm"}`}
                onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
              >
                <span className="flex items-center justify-center gap-2">
                  <XCircle className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
                  Close transaction
                </span>
              </button>
            </div>
          ) : hasActivePreAuth ? (
            <div className={`flex flex-col ${compact ? "gap-1.5" : "gap-3"}`}>
              {showPreAuthMismatchBanner && preAuthNozzleMismatch && (
                <PreAuthNozzleMismatchAlert
                  expectedProductName={preAuthNozzleMismatch.expectedProductName}
                  liftedProductName={preAuthNozzleMismatch.liftedProductName}
                  expectedColor={preAuthNozzleMismatch.expectedColor}
                  liftedColor={preAuthNozzleMismatch.liftedColor}
                />
              )}
              {showPreAuthTimeoutBanner && (
                <p className="text-center text-xs font-medium text-accent-amber">
                  Pre-authorization timed out — cancelled automatically
                </p>
              )}
              <button
                type="button"
                className={`w-full rounded-md bg-bg-secondary font-bold uppercase tracking-wider text-text-secondary border-2 border-border-primary transition-all duration-200 hover:bg-bg-tertiary hover:border-border-secondary active:bg-bg-primary active:border-border-primary ${primaryBtnH} ${compact ? "text-sm" : "text-sm"}`}
                onClick={() => onCancelPreAuth?.(state.fp_id)}
              >
                <span className="flex items-center justify-center gap-2">
                  <Ban className={compact ? "h-4 w-4" : "h-4 w-4"} />
                  {compact ? "Cancel" : "Cancel pre-authorization"}
                </span>
              </button>
            </div>
          ) : isContinuing && !isDelivering ? (
            <p className="text-center text-xs font-medium text-accent-blue/90">
              Resuming original fill — same product, price, and limit as the first authorization.
            </p>
          ) : canOpenPreAuthSetup && positionActive ? (
            <button
              type="button"
              className={`w-full rounded-md bg-accent-amber font-black uppercase tracking-widest text-text-inverse border-2 border-accent-amber-dark transition-all duration-200 hover:bg-accent-amber-light hover:border-accent-amber hover:shadow-lg active:bg-accent-amber-dark active:border-accent-amber-dark ${primaryBtnH} ${compact ? "text-sm" : "text-lg"}`}
              onClick={openPreAuthSetup}
            >
              <span className="flex items-center justify-center gap-2">
                <ShieldCheck className={compact ? "h-4 w-4" : "h-5 w-5"} />
                PRE-AUTHORIZE
              </span>
            </button>
          ) : canOpenReactiveSetup && positionActive ? (
            <button
              type="button"
              className={`w-full rounded-md bg-accent-emerald font-black uppercase tracking-widest text-text-inverse border-2 border-accent-emerald-dark transition-all duration-200 hover:bg-accent-emerald-light hover:border-accent-emerald hover:shadow-lg active:bg-accent-emerald-dark active:border-accent-emerald-dark ${primaryBtnH} ${compact ? "text-sm" : "text-lg"}`}
              onClick={() =>
                openReactiveSetup(
                  hasMultipleProducts ? undefined : activeNozzles[0]?.index,
                )
              }
            >
              <span className="flex items-center justify-center gap-2">
                <Fuel className={compact ? "h-4 w-4" : "h-5 w-5"} />
                {hasMultipleProducts
                  ? (compact ? "CHOOSE & AUTHORIZE" : "CHOOSE PRODUCT & AUTHORIZE")
                  : (compact ? "AUTHORIZE" : "SET UP & AUTHORIZE")}
              </span>
            </button>
          ) : isDone ? (
            <button
              type="button"
              className={`w-full rounded-md font-black uppercase tracking-widest text-text-inverse border-2 transition-all duration-200 hover:shadow-lg active:scale-[0.99] ${primaryBtnH} ${compact ? "text-sm" : "text-base"} ${
                holsterEndedSale
                  ? "bg-accent-amber border-accent-amber-dark hover:bg-accent-amber-light hover:border-accent-amber"
                  : "bg-accent-emerald border-accent-emerald-dark hover:bg-accent-emerald-light hover:border-accent-emerald"
              }`}
              onClick={() => onDismissSale?.(state.fp_id)}
            >
              {compact ? "Ready for next sale" : "Ready for next customer"}
            </button>
          ) : (
            <button
              type="button"
              disabled
              className={`w-full rounded-xl font-black uppercase tracking-widest cursor-not-allowed bg-bg-secondary/80 text-text-muted ${primaryBtnH} ${compact ? "text-sm" : "text-lg"}`}
            >
              {isOffline
                ? (compact ? "Pump offline" : "Pump offline — waiting for connection")
                : usePreAuth
                  ? (compact ? "Pre-authorize when ready" : "Holstered — pre-authorize when ready")
                  : "Awaiting nozzle"}
            </button>
          )}
        </div>
      </div>

      <AuthorizeModal
        open={modalOpen}
        state={state}
        fpNozzles={configuredNozzles}
        mode={modalMode}
        initialNozzle={modalNozzleHint}
        onClose={closeModal}
        onConfirm={handleModalConfirm}
      />
    </>
  );
}
