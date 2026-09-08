import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pausedInfo, statusTag } from "../types/api";
import type { AuthMode, FpState, FpStatus, NozzleSnapshot } from "../types/api";
import type { AuthorizeRequest, FillMode } from "./DispenserCard";
import { useAppStore } from "../store";
import { formatMoneyInput, parseMoney } from "../lib/money";
const fmtSum = new Intl.NumberFormat("uz-UZ");
const MAX_VOLUME_LITERS = 999;

function parseVolumeTarget(preset: string | null | undefined): number | null {
  if (!preset) return null;
  const m = preset.match(/([\d.,]+)\s*(?:L|m(?:3|³))/i);
  if (!m) return null;
  const v = Number.parseFloat(m[1].replace(",", "."));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function parseAmountTarget(preset: string | null | undefined): number | null {
  if (!preset) return null;
  const m = preset.match(/([\d.,\s]+)\s*sum/i);
  if (!m) return null;
  const v = Number.parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function draftFromPreAuthPreset(preset: string | null | undefined): Partial<PumpDraft> {
  if (!preset) return {};
  const volume = parseVolumeTarget(preset);
  if (volume != null) return { mode: "volume", volume: String(volume) };
  const amount = parseAmountTarget(preset);
  if (amount != null) return { mode: "amount", amount: formatMoneyInput(Math.round(amount)) };
  return { mode: "full", volume: "", amount: "" };
}

const FALLBACK_MAX_AMOUNT_SUM = 999_000_000;

function parseNum(s: string): number {
  const v = Number.parseFloat(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(v) ? v : 0;
}

function sanitizeVolumeInput(raw: string): string {
  const cleaned = raw.replace(",", ".").replace(/[^\d.]/g, "");
  const [head = "", ...tail] = cleaned.split(".");
  const whole = head.slice(0, 4);
  const fraction = tail.join("").slice(0, 3);
  if (cleaned.includes(".")) return `${whole || "0"}.${fraction}`;
  return whole;
}

function sanitizeAmountInput(raw: string): string {
  return formatMoneyInput(raw.replace(/\D/g, "").slice(0, 9));
}

function maxAmountForNozzle(nozzle: NozzleSnapshot | null): number {
  return nozzle?.price && nozzle.price > 0
    ? Math.floor(nozzle.price * MAX_VOLUME_LITERS)
    : FALLBACK_MAX_AMOUNT_SUM;
}

function isValidVolume(raw: string): boolean {
  const value = parseNum(raw);
  return value > 0 && value <= MAX_VOLUME_LITERS;
}

function isValidAmount(raw: string, nozzle: NozzleSnapshot | null): boolean {
  const value = parseNum(raw);
  return value > 0 && value <= maxAmountForNozzle(nozzle);
}

function relatedDraftValues(
  draft: PumpDraft | undefined,
  nozzle: NozzleSnapshot | null,
): Partial<PumpDraft> {
  if (!draft || !nozzle?.price || nozzle.price <= 0) return {};

  if (draft.mode === "amount") {
    const amount = parseMoney(draft.amount);
    if (amount > 0) {
      return { volume: String(Math.round((amount / nozzle.price) * 10) / 10) };
    }
  }

  if (draft.mode === "volume") {
    const volume = parseNum(draft.volume);
    if (volume > 0) {
      return { amount: formatMoneyInput(Math.round(volume * nozzle.price)) };
    }
  }

  return {};
}

function selectInputValue(input: HTMLInputElement) {
  window.requestAnimationFrame(() => input.select());
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    Boolean(target.closest("button, input, textarea, select, a, [role='button']"));
}

function pumpTitle(state: FpState): string {
  return state.label?.trim() ||
    (state.fp_id.match(/\d+/)?.[0] ? `${state.fp_id.match(/\d+/)![0]}-KOLONKA` : state.fp_id);
}

function pumpNumber(state: FpState): string {
  return state.fp_id.match(/\d+/)?.[0] ?? state.fp_id.slice(0, 2).toUpperCase();
}

function productColorFor(state: FpState, nozzle: NozzleSnapshot | null | undefined): string {
  return nozzle?.product_color ?? state.product_color ?? "#64748b";
}

type PumpTotalizerView = {
  nozzleIndex: number | null;
  volume: number | null;
  amount: number | null;
  price: number | null;
};

/// Lifetime pump totals for the selected nozzle: prefer the per-nozzle `pump_totals`
/// entry, else fall back to the legacy single-nozzle fields. Returns null when the
/// pump reported no totals (i.e. non-Gilbarco lanes / undecodable pumps).
function pickPumpTotalizer(state: FpState, selectedNozzleIndex: number | null): PumpTotalizerView | null {
  const match =
    selectedNozzleIndex != null
      ? state.pump_totals?.find((tt) => tt.nozzle_index === selectedNozzleIndex)
      : undefined;
  if (match) {
    return {
      nozzleIndex: match.nozzle_index,
      volume: match.volume,
      amount: match.amount,
      price: match.price,
    };
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
}

type PumpDraft = {
  nozzleIndex: number | null;
  mode: FillMode;
  volume: string;
  amount: string;
  lastFillVolume: number | null;
  lastFillAmount: number | null;
  lastFillPreset: string | null;
};

type PumpMeta = {
  tag: ReturnType<typeof statusTag>;
  paused: ReturnType<typeof pausedInfo>;
  isIdle: boolean;
  isNozzleUp: boolean;
  isOffline: boolean;
  isDelivering: boolean;
  isAuthorizing: boolean;
  isPaused: boolean;
  hasActivePreAuth: boolean;
  canAuthorize: boolean;
};

type OrderField = "volume" | "amount";

type Props = {
  states: FpState[];
  nozzlesByFp: Map<string, NozzleSnapshot[]>;
  positionActiveByFp: Map<string, boolean>;
  activeFpId: string | null;
  onSelectFp: (fpId: string) => void;
  defaultAuthMode: AuthMode;
  onAuthorize: (req: AuthorizeRequest) => void;
  onPreAuthorize?: (req: AuthorizeRequest) => void;
  onCancelPreAuth?: (fpId: string) => void;
  onStop: (fpId: string) => void;
  onCancel?: (fpId: string) => void;
  onCloseStopped: (fpId: string, stoppedTxId: string) => void;
  shiftRequired?: boolean;
  onStartShift?: () => void;
  useCancelMode?: boolean;
  gilbarcoMode?: boolean;
};

function getMeta(
  state: FpState,
  defaultAuthMode: AuthMode,
  positionActive: boolean,
): PumpMeta {
  const tag = statusTag(state.status as FpStatus);
  const paused = pausedInfo(state);
  const isIdle = tag === "IDLE";
  const isNozzleUp = tag === "NOZZLE_UP";
  const isOffline = tag === "OFFLINE";
  const isDelivering = tag === "DELIVERING";
  const isAuthorizing = tag === "AUTHORIZING";
  const isPaused = paused != null;
  const hasActivePreAuth =
    tag === "PRE_AUTHORIZED" ||
    (state.pre_auth_preset != null &&
      tag !== "DONE" &&
      tag !== "DELIVERING" &&
      tag !== "AUTHORIZING" &&
      tag !== "OFFLINE");
  const canOpenPreAuth =
    (isIdle || isNozzleUp) &&
    defaultAuthMode === "preauth" &&
    !isPaused &&
    !hasActivePreAuth;
  const canOpenReactive =
    isNozzleUp &&
    defaultAuthMode !== "preauth" &&
    !isPaused &&
    !hasActivePreAuth;
  return {
    tag,
    paused,
    isIdle,
    isNozzleUp,
    isOffline,
    isDelivering,
    isAuthorizing,
    isPaused,
    hasActivePreAuth,
    canAuthorize: positionActive && !isOffline && (canOpenPreAuth || canOpenReactive),
  };
}

function statusTintClass(meta: PumpMeta): string {
  if (meta.isOffline) return "border-l-2 border-l-accent-red bg-bg-secondary/30 text-accent-red";
  if (meta.isDelivering || meta.isAuthorizing) return "border-l-2 border-l-accent-emerald bg-bg-secondary/30 text-accent-emerald";
  if (meta.hasActivePreAuth || meta.isPaused) return "border-l-2 border-l-accent-amber bg-bg-secondary/30 text-accent-amber";
  if (meta.isNozzleUp) return "border-l-2 border-l-accent-blue bg-bg-secondary/30 text-accent-blue";
  return "border-l-2 border-l-border-primary bg-bg-secondary/30 text-text-secondary";
}

function statusSolidClass(meta: PumpMeta): string {
  if (meta.isOffline) return "border-accent-red/65 bg-bg-secondary text-accent-red";
  if (meta.isDelivering || meta.isAuthorizing) return "border-accent-emerald/65 bg-bg-secondary text-accent-emerald";
  if (meta.hasActivePreAuth || meta.isPaused) return "border-accent-amber/65 bg-bg-secondary text-accent-amber";
  if (meta.isNozzleUp) return "border-accent-blue/65 bg-bg-secondary text-accent-blue";
  return "border-border-primary/60 bg-bg-secondary text-text-secondary";
}

function classicStatusLabel(meta: PumpMeta, t: (key: string) => string): string {
  const key = meta.isPaused
    ? "STOPPED"
    : meta.hasActivePreAuth
      ? "PRE_AUTHORIZED"
      : meta.tag;
  const label = t(`classic.statusLabels.${key}`);
  return label === `classic.statusLabels.${key}` ? t("classic.statusLabels.UNKNOWN") : label;
}

export function ClassicDispenserConsole({
  states,
  nozzlesByFp,
  positionActiveByFp,
  activeFpId,
  onSelectFp,
  defaultAuthMode,
  onAuthorize,
  onPreAuthorize,
  onCancelPreAuth,
  onStop,
  onCancel,
  onCloseStopped,
  shiftRequired = false,
  onStartShift,
  useCancelMode = false,
  gilbarcoMode = false,
}: Props) {
  const { t } = useTranslation();
  const siteSnapshot = useAppStore((s) => s.siteSnapshot);
  // Wrong-nozzle-during-preauth alert (backend already cancels the preauth and
  // emits fp.pre_auth_nozzle_mismatch; surface it here so the operator sees it).
  const preAuthNozzleMismatch = useAppStore((s) => s.preAuthNozzleMismatch);
  const clearPreAuthNozzleMismatch = useAppStore((s) => s.clearPreAuthNozzleMismatch);
  useEffect(() => {
    if (!preAuthNozzleMismatch) return;
    // Fallback only: the backend pushes IDLE the moment the wrong nozzle is holstered,
    // which clears the banner. This timer just bounds the case where it is never holstered.
    const tmr = window.setTimeout(() => clearPreAuthNozzleMismatch(), 10000);
    return () => window.clearTimeout(tmr);
  }, [preAuthNozzleMismatch, clearPreAuthNozzleMismatch]);
  const [drafts, setDrafts] = useState<Record<string, PumpDraft>>({});
  const consoleRef = useRef<HTMLDivElement>(null);
  const pumpButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const bottomPanelRef = useRef<HTMLDivElement>(null);
  const fullFillArmedRef = useRef<{ fpId: string; at: number } | null>(null);
  const prevTagsRef = useRef<Record<string, string>>({});

  // Dynamically adapt to available vertical space with mathematical scaling
  const [scale, setScale] = useState(1);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = consoleRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    let rafId: number;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const containerH = container.clientHeight;
        const naturalH = content.offsetHeight;
        if (containerH > 0 && naturalH > 0) {
          // If content is taller than available space, scale it down proportionally
          const newScale = containerH / naturalH;
          setScale(newScale < 1 ? newScale : 1);
        }
      });
    });

    observer.observe(container);
    observer.observe(content);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [states.length]);

  const dense = states.length >= 6;

  // Six-pump layouts use genuinely smaller controls so the console remains
  // readable without relying on aggressive whole-page scaling.
  const ui = {
    topGridGap: "gap-2",
    topCardPad: dense ? "p-2" : "p-3",
    topCardText: dense ? "text-lg" : "text-xl",
    topCardLabel: dense ? "text-xs" : "text-sm",
    bottomLiveText: dense ? "text-4xl" : "text-5xl",
    tableLiveText: dense ? "text-2xl" : "text-3xl",
    priceText: dense ? "text-2xl" : "text-3xl",
    productPriceText: dense ? "text-sm" : "text-lg",
    
    thPad: dense ? "px-3 py-2" : "px-4 py-3",
    tdPad: dense ? "px-2 py-1.5" : "px-3 py-2",
    thText: dense ? "text-[11px]" : "text-xs",
    
    inputHeight: dense ? "h-10" : "h-12",
    inputText: dense ? "text-lg" : "text-2xl",
    inputPad: dense ? "px-2" : "px-4",
    
    modeBtnPad: dense ? "px-2 py-1.5" : "px-3 py-2",
    modeBtnText: dense ? "text-xs" : "text-base",
    
    btnHeight: dense ? "h-9" : "h-10",
    btnPad: dense ? "px-3" : "px-4",
    btnText: dense ? "text-sm" : "text-base",
  };

  const focusControlClass =
    "transition-[border-color,background-color] duration-75 focus:border-accent-blue focus:bg-bg-primary focus:ring-2 focus:ring-inset focus:ring-accent-blue/35 focus:outline-none";
  const invalidInputClass =
    "border-accent-red/70 bg-accent-red/10 text-text-primary focus:border-accent-red focus:ring-accent-red/30";
  const lockedInputClass =
    "cursor-not-allowed border-border-primary/30 bg-bg-secondary/40 text-text-muted opacity-70";
  const selectedOrderInputClass =
    "!border-2 !border-accent-blue !bg-accent-blue/25 !text-text-primary caret-text-primary";
  const centerOrderFocusClass =
    "focus:bg-accent-blue/15 focus:text-text-primary focus:caret-text-primary focus:ring-2 focus:ring-inset focus:ring-accent-blue/40";
  const bottomControlWrapClass =
    `group flex flex-col gap-1 rounded border border-border-primary/50 bg-bg-secondary/20 shadow-none ${dense ? "p-2" : "p-3"} transition-colors duration-100 focus-within:border-accent-blue focus-within:bg-accent-blue/5 focus-within:shadow-none`;
  const bottomLabelClass =
    `mb-1 block ${dense ? "text-xs" : "text-sm"} font-semibold uppercase tracking-wide text-text-secondary transition-colors duration-75 group-focus-within:text-accent-blue`;
  const tableUnitSlotClass = `${dense ? "w-10" : "w-14"} shrink-0`;
  const centerUnitClass = `${dense ? "text-[9px]" : "text-xs"} font-semibold uppercase text-text-secondary`;
  const centerValueUnitClass = `${dense ? "text-xs" : "text-sm"} font-semibold uppercase text-text-secondary`;
  const tableRowHeaderClass =
    `sticky left-0 z-10 border-r border-border-primary/50 bg-bg-secondary ${ui.thPad} text-left ${ui.thText} font-semibold uppercase tracking-wide text-text-secondary`;

  useEffect(() => {
    const prevTags = prevTagsRef.current;
    const nextPrevTags: Record<string, string> = {};
    for (const state of states) {
      nextPrevTags[state.fp_id] = statusTag(state.status as FpStatus);
    }

    setDrafts((prev) => {
      const next: Record<string, PumpDraft> = {};
      for (const state of states) {
        const nozzles = (nozzlesByFp.get(state.fp_id) ?? []).filter((n) => n.active);
        const prevDraft = prev[state.fp_id];
        const prevNozzleValid =
          prevDraft?.nozzleIndex != null && nozzles.some((n) => n.index === prevDraft.nozzleIndex);
        const stateNozzleValid =
          state.nozzle_index != null && nozzles.some((n) => n.index === state.nozzle_index);
        const tag = nextPrevTags[state.fp_id]!;
        const followHardwareNozzle = stateNozzleValid && tag !== "IDLE";
        const nozzleIndex = followHardwareNozzle
          ? state.nozzle_index
          : prevNozzleValid
            ? prevDraft!.nozzleIndex
            : stateNozzleValid
            ? state.nozzle_index
            : nozzles.length === 1
              ? (nozzles[0]?.index ?? null)
              : null;
        const prevTag = prevTags[state.fp_id];
        const wasActive = prevTag === "DELIVERING" || prevTag === "AUTHORIZING";
        const enteredStopped = tag === "STOPPED" && prevTag !== "STOPPED";
        const stoppedClosed = prevTag === "STOPPED" && tag === "IDLE";
        const stopped = pausedInfo(state);
        const completedVolume = stopped?.stopped_volume ?? state.volume;
        const completedAmount = stopped?.stopped_amount ?? state.amount;
        // An armed setup (pre-auth) or a bare nozzle-up that drops back to IDLE without
        // fueling — e.g. a wrong-nozzle pre-auth mismatch that cancels and returns to
        // idle once the wrong nozzle is holstered. The old volume/amount from that
        // pre-auth must not linger in the inputs.
        const setupAbandoned =
          (prevTag === "PRE_AUTHORIZED" || prevTag === "NOZZLE_UP") && tag === "IDLE";
        // Clear inputs after a successful fill (status hits DONE, or DONE was skipped and
        // we jump straight from an active state to IDLE) OR when a setup was abandoned.
        const clearValues =
          tag === "DONE" || enteredStopped || stoppedClosed || (wasActive && tag === "IDLE") || setupAbandoned;
        // Capture last-fill snapshot when the fill just ended.
        const captureLastFill =
          (tag === "DONE" || enteredStopped || stoppedClosed || (wasActive && tag === "IDLE")) &&
          completedVolume > 0;
        // Reset last-fill snapshot when a new transaction begins.
        const clearLastFill = tag === "NOZZLE_UP" || tag === "AUTHORIZING" || tag === "DELIVERING";
        const presetDraft =
          !clearValues && state.pre_auth_preset != null
            ? draftFromPreAuthPreset(state.pre_auth_preset)
            : {};
        next[state.fp_id] = {
          nozzleIndex,
          mode: presetDraft.mode ?? prevDraft?.mode ?? "volume",
          volume: clearValues ? "" : (presetDraft.volume ?? prevDraft?.volume ?? ""),
          amount: clearValues ? "" : (presetDraft.amount ?? prevDraft?.amount ?? ""),
          lastFillVolume: clearLastFill ? null : captureLastFill ? completedVolume : (prevDraft?.lastFillVolume ?? null),
          lastFillAmount: clearLastFill ? null : captureLastFill ? completedAmount : (prevDraft?.lastFillAmount ?? null),
          lastFillPreset: clearLastFill ? null : captureLastFill ? (state.pre_auth_preset ?? null) : (prevDraft?.lastFillPreset ?? null),
        };
      }
      return next;
    });

    prevTagsRef.current = nextPrevTags;
  }, [states, nozzlesByFp]);

  const activeState = useMemo(() => {
    if (activeFpId) {
      const found = states.find((s) => s.fp_id === activeFpId);
      if (found) return found;
    }
    return states[0] ?? null;
  }, [activeFpId, states]);

  const setDraft = useCallback((fpId: string, patch: Partial<PumpDraft>) => {
    setDrafts((prev) => {
      const current: PumpDraft = prev[fpId] ?? {
        nozzleIndex: null,
        mode: "volume",
        volume: "",
        amount: "",
        lastFillVolume: null,
        lastFillAmount: null,
        lastFillPreset: null,
      };
      return {
        ...prev,
        [fpId]: {
          ...current,
          ...patch,
        },
      };
    });
  }, []);

  const selectedNozzle = useCallback((state: FpState) => {
    const nozzles = (nozzlesByFp.get(state.fp_id) ?? []).filter((n) => n.active);
    const draft = drafts[state.fp_id];
    const idx = draft?.nozzleIndex ?? (nozzles.length === 1 ? nozzles[0]!.index : null);
    return nozzles.find((n) => n.index === idx) ?? null;
  }, [drafts, nozzlesByFp]);

  const volumeUnitFor = useCallback(
    (state: FpState, nozzle: NozzleSnapshot | null = selectedNozzle(state)) => {
      const productId = nozzle?.product_id ?? state.product_id ?? null;
      return siteSnapshot?.products.find((product) => product.id === productId)?.unit?.trim() || "L";
    },
    [selectedNozzle, siteSnapshot],
  );

  useEffect(() => {
    setDrafts((prev) => {
      let changed = false;
      const next: Record<string, PumpDraft> = { ...prev };

      for (const state of states) {
        const draft = prev[state.fp_id];
        if (!draft) continue;
        const nozzles = (nozzlesByFp.get(state.fp_id) ?? []).filter((n) => n.active);
        const nozzle =
          nozzles.find((n) => n.index === draft.nozzleIndex) ??
          (nozzles.length === 1 ? (nozzles[0] ?? null) : null);
        const patch = relatedDraftValues(draft, nozzle);
        const volumeChanged = patch.volume != null && patch.volume !== draft.volume;
        const amountChanged = patch.amount != null && patch.amount !== draft.amount;
        if (!volumeChanged && !amountChanged) continue;
        next[state.fp_id] = {
          ...draft,
          ...patch,
        };
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [states, nozzlesByFp]);

  const buildRequest = useCallback((state: FpState): AuthorizeRequest | null => {
    const draft = drafts[state.fp_id];
    const nozzle = selectedNozzle(state);
    if (!draft || !nozzle) return null;
    let limitValue: number | null = null;
    if (draft.mode === "volume") {
      const v = parseNum(draft.volume);
      if (!isValidVolume(draft.volume)) return null;
      limitValue = v;
    } else if (draft.mode === "amount") {
      const a = parseNum(draft.amount);
      if (!isValidAmount(draft.amount, nozzle)) return null;
      limitValue = a;
    }
    return {
      fpId: state.fp_id,
      nozzleIndex: nozzle.index,
      fillMode: draft.mode,
      limitValue,
      priceOverride: null,
    };
  }, [drafts, selectedNozzle]);

  const startPump = useCallback((state: FpState) => {
    const positionActive = positionActiveByFp.get(state.fp_id) ?? true;
    const meta = getMeta(state, defaultAuthMode, positionActive);
    if (shiftRequired) {
      onStartShift?.();
      return;
    }
    if (!meta.canAuthorize) return;
    const req = buildRequest(state);
    if (!req) return;
    if (defaultAuthMode === "preauth" && !meta.isNozzleUp) onPreAuthorize?.(req);
    else onAuthorize(req);
  }, [
    buildRequest,
    defaultAuthMode,
    onAuthorize,
    onPreAuthorize,
    onStartShift,
    positionActiveByFp,
    shiftRequired,
  ]);

  const focusPump = useCallback((fpId: string) => {
    onSelectFp(fpId);
    window.requestAnimationFrame(() => {
      pumpButtonRefs.current.get(fpId)?.focus();
    });
  }, [onSelectFp]);

  const handlePassivePumpMouseDown = useCallback((fpId: string, e: MouseEvent<HTMLElement>) => {
    if (isInteractiveTarget(e.target)) return;
    onSelectFp(fpId);
  }, [onSelectFp]);

  const handleTableMouseDown = useCallback((e: MouseEvent<HTMLTableElement>) => {
    if (isInteractiveTarget(e.target)) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    const cell = target?.closest<HTMLElement>("[data-fp-id]");
    const fpId = cell?.dataset.fpId;
    if (fpId) onSelectFp(fpId);
  }, [onSelectFp]);

  const focusBottomControl = useCallback((controlName: string) => {
    window.requestAnimationFrame(() => {
      const root = bottomPanelRef.current;
      const control = root?.querySelector<HTMLElement>(`[data-classic-control='${controlName}']`);
      const focusTarget =
        control?.matches("button,input,select")
          ? control
          : control?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])");
      focusTarget?.focus();
      if (focusTarget instanceof HTMLInputElement) selectInputValue(focusTarget);
    });
  }, []);

  const focusTableOrderField = useCallback((fpId: string, field: OrderField) => {
    onSelectFp(fpId);
    window.requestAnimationFrame(() => {
      const root = consoleRef.current;
      const container = root?.querySelector<HTMLElement>(`[data-table-row='${field}'][data-fp-id='${fpId}']`);
      const focusTarget = container?.querySelector<HTMLInputElement>("input:not([disabled])");
      focusTarget?.focus();
      if (focusTarget) selectInputValue(focusTarget);
    });
  }, [onSelectFp]);

  const focusBottomOrderField = useCallback((fpId: string, field: OrderField) => {
    onSelectFp(fpId);
    focusBottomControl(field);
  }, [focusBottomControl, onSelectFp]);

  const focusBottomControlByOffset = useCallback((currentName: string | null, offset: number) => {
    const root = bottomPanelRef.current;
    if (!root) return;
    const controls = Array.from(root.querySelectorAll<HTMLElement>("[data-classic-control]"))
      .filter((el) => {
        if (el.matches("button,input,select")) return !(el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled;
        return Boolean(el.querySelector("button:not([disabled]), input:not([disabled]), select:not([disabled])"));
      });
    if (!controls.length) return;
    const currentIndex = currentName
      ? controls.findIndex((el) => el.dataset.classicControl === currentName)
      : -1;
    const baseIndex = currentIndex >= 0 ? currentIndex : (offset > 0 ? -1 : 0);
    const next = controls[(baseIndex + offset + controls.length) % controls.length];
    const name = next?.dataset.classicControl;
    if (name) focusBottomControl(name);
  }, [focusBottomControl]);

  const selectPumpByOffset = useCallback((fromFpId: string, offset: number, focusControlName?: string | null, tableRowName?: string | null) => {
    const idx = states.findIndex((s) => s.fp_id === fromFpId);
    if (idx < 0 || states.length === 0) return;
    const next = states[(idx + offset + states.length) % states.length];
    if (!next) return;
    onSelectFp(next.fp_id);
    if (focusControlName) {
      focusBottomControl(focusControlName);
    } else if (tableRowName) {
      window.requestAnimationFrame(() => {
        const root = consoleRef.current;
        const container = root?.querySelector<HTMLElement>(`[data-table-row='${tableRowName}'][data-fp-id='${next.fp_id}']`);
        const focusTarget = container?.matches("button,input,select") ? container : container?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])");
        focusTarget?.focus();
        if (focusTarget instanceof HTMLInputElement) selectInputValue(focusTarget);
      });
    } else {
      window.requestAnimationFrame(() => {
        pumpButtonRefs.current.get(next.fp_id)?.focus();
      });
    }
  }, [focusBottomControl, onSelectFp, states]);

  const handlePumpKeyDown = useCallback((state: FpState, e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      selectPumpByOffset(state.fp_id, 1);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      selectPumpByOffset(state.fp_id, -1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusTableOrderField(state.fp_id, "volume");
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      focusTableOrderField(state.fp_id, "amount");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      startPump(state);
    }
  }, [focusTableOrderField, selectPumpByOffset, startPump]);

  const handleEditKeyDown = useCallback((state: FpState, e: KeyboardEvent<HTMLElement>) => {
    const currentControl = (e.currentTarget.closest("[data-classic-control]") as HTMLElement | null)
      ?.dataset.classicControl ?? null;
    const tableRowName = (e.currentTarget.closest("[data-table-row]") as HTMLElement | null)
      ?.dataset.tableRow ?? null;

    if (e.key === "Enter") {
      e.preventDefault();
      startPump(state);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      focusPump(state.fp_id);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      selectPumpByOffset(state.fp_id, 1, currentControl, tableRowName);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      selectPumpByOffset(state.fp_id, -1, currentControl, tableRowName);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (tableRowName === "volume" || tableRowName === "amount") {
        focusTableOrderField(state.fp_id, tableRowName === "volume" ? "amount" : "volume");
      } else if (currentControl === "volume" || currentControl === "amount") {
        focusBottomOrderField(state.fp_id, currentControl === "volume" ? "amount" : "volume");
      } else {
        focusTableOrderField(state.fp_id, "volume");
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (tableRowName === "volume" || tableRowName === "amount") {
        focusTableOrderField(state.fp_id, tableRowName === "volume" ? "amount" : "volume");
      } else if (currentControl === "volume" || currentControl === "amount") {
        focusBottomOrderField(state.fp_id, currentControl === "volume" ? "amount" : "volume");
      } else {
        focusTableOrderField(state.fp_id, "amount");
      }
    }
  }, [focusBottomOrderField, focusPump, focusTableOrderField, selectPumpByOffset, startPump]);

  const handleControlNavKeyDown = useCallback((state: FpState, e: KeyboardEvent<HTMLElement>) => {
    const currentControl = (e.currentTarget.closest("[data-classic-control]") as HTMLElement | null)
      ?.dataset.classicControl ?? null;
    if (e.key === "Escape") {
      e.preventDefault();
      focusPump(state.fp_id);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusBottomControlByOffset(currentControl, 1);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusBottomControlByOffset(currentControl, -1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (currentControl === "volume" || currentControl === "amount") {
        focusBottomOrderField(state.fp_id, currentControl === "volume" ? "amount" : "volume");
      } else {
        focusBottomOrderField(state.fp_id, "volume");
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (currentControl === "volume" || currentControl === "amount") {
        focusBottomOrderField(state.fp_id, currentControl === "volume" ? "amount" : "volume");
      } else {
        focusBottomOrderField(state.fp_id, "amount");
      }
    }
  }, [focusBottomControlByOffset, focusBottomOrderField, focusPump]);

  const updateVolume = useCallback((state: FpState, raw: string) => {
    const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
    if (meta.hasActivePreAuth || meta.isDelivering || meta.isAuthorizing || meta.isPaused) return;
    const nextRaw = sanitizeVolumeInput(raw);
    const nozzle = selectedNozzle(state);
    const liters = parseNum(nextRaw);
    setDraft(state.fp_id, {
      mode: "volume",
      volume: nextRaw,
      amount: nextRaw === "" ? "" : nozzle?.price && liters > 0 ? formatMoneyInput(Math.round(liters * nozzle.price)) : drafts[state.fp_id]?.amount,
    });
  }, [defaultAuthMode, drafts, positionActiveByFp, selectedNozzle, setDraft]);

  const updateAmount = useCallback((state: FpState, raw: string) => {
    const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
    if (meta.hasActivePreAuth || meta.isDelivering || meta.isAuthorizing || meta.isPaused) return;
    const nextRaw = sanitizeAmountInput(raw);
    const nozzle = selectedNozzle(state);
    const amount = parseMoney(nextRaw);
    setDraft(state.fp_id, {
      mode: "amount",
      amount: nextRaw,
      volume: nextRaw === "" ? "" : nozzle?.price && amount > 0 ? String(Math.round((amount / nozzle.price) * 10) / 10) : drafts[state.fp_id]?.volume,
    });
  }, [defaultAuthMode, drafts, positionActiveByFp, selectedNozzle, setDraft]);

  const armFullFill = useCallback((state: FpState) => {
    const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
    if (meta.hasActivePreAuth || meta.isDelivering || meta.isAuthorizing || meta.isPaused) return;
    setDraft(state.fp_id, { mode: "full", volume: "", amount: "" });
    fullFillArmedRef.current = { fpId: state.fp_id, at: Date.now() };
    focusBottomControl("action");
  }, [defaultAuthMode, focusBottomControl, positionActiveByFp, setDraft]);

  const toggleSelectedOrderInput = useCallback((state: FpState) => {
    const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
    if (meta.hasActivePreAuth || meta.isDelivering || meta.isAuthorizing || meta.isPaused) return;
    const focusedControl = (document.activeElement as HTMLElement | null)
      ?.closest<HTMLElement>("[data-classic-control]")
      ?.dataset.classicControl;
    const currentMode = drafts[state.fp_id]?.mode;
    const nextMode: FillMode =
      focusedControl === "amount" || (focusedControl == null && currentMode === "amount")
        ? "volume"
        : "amount";
    setDraft(state.fp_id, { mode: nextMode });
    focusBottomControl(nextMode);
  }, [defaultAuthMode, drafts, focusBottomControl, positionActiveByFp, setDraft]);

  const stopOrCancelSelected = useCallback((state: FpState) => {
    const positionActive = positionActiveByFp.get(state.fp_id) ?? true;
    const meta = getMeta(state, defaultAuthMode, positionActive);
    if (meta.isDelivering || meta.isAuthorizing) {
      onStop(state.fp_id);
      return;
    }
    if (meta.hasActivePreAuth) {
      onCancelPreAuth?.(state.fp_id);
    }
  }, [defaultAuthMode, onCancelPreAuth, onStop, positionActiveByFp]);

  const cycleSelectedProduct = useCallback((state: FpState) => {
    const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
    if (meta.hasActivePreAuth || meta.isDelivering || meta.isAuthorizing || meta.isPaused) return;
    const nozzles = (nozzlesByFp.get(state.fp_id) ?? []).filter((n) => n.active);
    if (nozzles.length <= 1) return;
    const draft = drafts[state.fp_id];
    const currentIndex = nozzles.findIndex((n) => n.index === draft?.nozzleIndex);
    const next = nozzles[(currentIndex + 1 + nozzles.length) % nozzles.length];
    if (!next) return;
    setDraft(state.fp_id, {
      nozzleIndex: next.index,
      ...relatedDraftValues(draft, next),
    });
  }, [defaultAuthMode, drafts, nozzlesByFp, positionActiveByFp, setDraft]);

  const handleConsoleKeyDownCapture = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const handledKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "Delete", "Home", "Enter", "Shift"];
    if (!handledKeys.includes(e.key)) return;
    const selectedState = activeState ?? states[0];
    if (!selectedState) return;

    if (e.key === "Shift") {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      toggleSelectedOrderInput(selectedState);
      return;
    }

    if (e.key === "PageUp") {
      e.preventDefault();
      e.stopPropagation();
      armFullFill(selectedState);
      return;
    }

    if (e.key === "Enter") {
      const armed = fullFillArmedRef.current;
      if (!armed || armed.fpId !== selectedState.fp_id || Date.now() - armed.at > 5000) return;
      e.preventDefault();
      e.stopPropagation();
      fullFillArmedRef.current = null;
      startPump(selectedState);
      return;
    }

    if (e.key === "Delete") {
      e.preventDefault();
      e.stopPropagation();
      stopOrCancelSelected(selectedState);
      return;
    }

    if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      cycleSelectedProduct(selectedState);
      return;
    }

    const target = e.target as HTMLElement | null;

    const currentControl = target?.closest<HTMLElement>("[data-classic-control]")?.dataset.classicControl ?? null;
    const tableRowName = target?.closest<HTMLElement>("[data-table-row]")?.dataset.tableRow ?? null;
    const keepBottomFocus = currentControl != null && bottomPanelRef.current?.contains(target);

    e.preventDefault();
    e.stopPropagation();

    if (e.key === "ArrowRight") {
      selectPumpByOffset(selectedState.fp_id, 1, keepBottomFocus ? currentControl : null, tableRowName);
      return;
    }
    if (e.key === "ArrowLeft") {
      selectPumpByOffset(selectedState.fp_id, -1, keepBottomFocus ? currentControl : null, tableRowName);
      return;
    }
    if (e.key === "ArrowDown") {
      if (keepBottomFocus) {
        focusBottomOrderField(selectedState.fp_id, currentControl === "volume" ? "amount" : "volume");
      } else if (tableRowName === "volume" || tableRowName === "amount") {
        focusTableOrderField(selectedState.fp_id, tableRowName === "volume" ? "amount" : "volume");
      } else {
        focusTableOrderField(selectedState.fp_id, "volume");
      }
      return;
    }
    if (keepBottomFocus) {
      focusBottomOrderField(selectedState.fp_id, currentControl === "amount" ? "volume" : "amount");
    } else if (tableRowName === "volume" || tableRowName === "amount") {
      focusTableOrderField(selectedState.fp_id, tableRowName === "amount" ? "volume" : "amount");
    } else {
      focusTableOrderField(selectedState.fp_id, "amount");
    }
  }, [
    activeState,
    armFullFill,
    cycleSelectedProduct,
    focusBottomOrderField,
    focusTableOrderField,
    selectPumpByOffset,
    startPump,
    states,
    stopOrCancelSelected,
    toggleSelectedOrderInput,
  ]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const handledKeys = ["ArrowLeft", "ArrowRight", "Delete", "PageUp", "Enter"];
      if (!handledKeys.includes(event.key)) return;

      const root = consoleRef.current;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const focusedElement = target ?? activeElement;

      if (root && focusedElement && root.contains(focusedElement)) return;
      if (focusedElement?.closest("[role='dialog']")) return;
      const isArrow = event.key === "ArrowRight" || event.key === "ArrowLeft";
      const isTextEditing =
        focusedElement &&
        (focusedElement.matches("input, textarea, select") || focusedElement.isContentEditable);
      if (isTextEditing) {
        return;
      }
      if (
        !isArrow &&
        focusedElement &&
        focusedElement.matches("button, a")
      ) {
        return;
      }

      const selectedState = activeState ?? states[0];
      if (!selectedState) return;

      event.preventDefault();
      if (isArrow) {
        selectPumpByOffset(selectedState.fp_id, event.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (event.key === "Delete") {
        stopOrCancelSelected(selectedState);
        return;
      }
      if (event.key === "PageUp") {
        armFullFill(selectedState);
        return;
      }
      startPump(selectedState);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [activeState, armFullFill, selectPumpByOffset, startPump, states, stopOrCancelSelected]);

  const renderAction = (state: FpState, compact = false) => {
    const positionActive = positionActiveByFp.get(state.fp_id) ?? true;
    const meta = getMeta(state, defaultAuthMode, positionActive);
    const paused = meta.paused;
    const baseClass = `${ui.btnHeight} ${ui.btnPad} ${ui.btnText} rounded-none`;
    const cls = `${baseClass} w-full flex-1 font-semibold uppercase tracking-wide outline-none shadow-none transition-colors duration-75 active:brightness-95 focus-visible:brightness-95 disabled:cursor-not-allowed disabled:opacity-50`;

    if (meta.canAuthorize) {
      return (
        <button
          type="button"
          disabled={!shiftRequired && !buildRequest(state)}
          onClick={() => startPump(state)}
          className={`${cls} border border-accent-emerald/80 bg-accent-emerald text-white hover:bg-accent-emerald-light`}
        >
          {shiftRequired ? t("classic.startShift") : t("classic.start")}
        </button>
      );
    }
    if (meta.isDelivering || meta.isAuthorizing) {
      const cancel = useCancelMode && onCancel != null;
      return (
        <button
          type="button"
          onClick={() => cancel ? onCancel(state.fp_id) : onStop(state.fp_id)}
          className={`${cls} border ${
            cancel
              ? "border-accent-red/80 bg-accent-red text-white hover:bg-accent-red-light"
              : "border-accent-amber/80 bg-accent-amber text-white hover:bg-accent-amber-light"
          }`}
        >
          {cancel ? t("classic.cancel") : t("classic.stop")}
        </button>
      );
    }
    if (meta.hasActivePreAuth && !meta.isDelivering && !meta.isPaused) {
      return (
        <button
          type="button"
          onClick={() => onCancelPreAuth?.(state.fp_id)}
          className={`${cls} border border-border-primary bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary hover:border-text-primary/20 focus-visible:border-accent-blue`}
        >
          {t("classic.cancelPreAuth")}
        </button>
      );
    }
    if (paused) {
      return (
        <button
          type="button"
          onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
          className={`${cls} border border-border-primary bg-bg-tertiary text-text-primary hover:bg-bg-secondary hover:border-text-primary/20 focus-visible:border-accent-blue`}
        >
          {t("classic.close")}
        </button>
      );
    }
    return <div className={`${ui.btnHeight} flex items-center justify-center`}><span className="text-[11px] font-bold tracking-wider text-text-muted/60 uppercase">--</span></div>;
  };

  const renderModeButtons = (state: FpState, compact = false, keyboardControls = false) => {
    const draft = drafts[state.fp_id];
    const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
    const setupLocked = meta.hasActivePreAuth || meta.isDelivering || meta.isAuthorizing || meta.isPaused;
    const modes: FillMode[] = ["full", "volume", "amount"];
    const modeColorClass = (_mode: FillMode, active: boolean) =>
      active
        ? "border border-accent-blue bg-accent-blue text-white"
        : "border border-border-primary/60 bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus-visible:border-accent-blue";
    return (
      <div className="flex items-center justify-center gap-1 rounded border border-border-primary/40 bg-bg-input/50 p-1 shadow-none">
        {modes.map((mode) => {
          const isActive = draft?.mode === mode;
          return (
            <button
              key={mode}
              type="button"
              data-classic-control={keyboardControls ? `mode-${mode}` : undefined}
              disabled={setupLocked}
              onClick={() => {
                if (setupLocked) return;
                setDraft(state.fp_id, mode === "full" ? { mode, volume: "", amount: "" } : { mode });
              }}
              onKeyDown={keyboardControls ? (e) => handleControlNavKeyDown(state, e) : undefined}
              className={`flex-1 rounded shadow-none transition-colors duration-100 outline-none disabled:cursor-not-allowed disabled:opacity-60 ${ui.modeBtnPad} ${ui.modeBtnText} font-semibold uppercase ${modeColorClass(mode, isActive)}`}
            >
              {mode === "full"
                ? t("classic.full")
                : mode === "volume"
                  ? t("classic.volume")
                  : t("classic.amount")}
            </button>
          );
        })}
      </div>
    );
  };

  if (states.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-none border border-border-primary bg-bg-card text-sm font-semibold text-text-muted">
        {t("classic.noDispensers")}
      </div>
    );
  }

  const selected = activeState ?? states[0]!;
  const selectedNozzles = (nozzlesByFp.get(selected.fp_id) ?? []).filter((n) => n.active);
  const selectedDraft = drafts[selected.fp_id];
  const selectedProduct = selectedNozzle(selected);
  const selectedVolumeUnit = volumeUnitFor(selected, selectedProduct);
  const selectedProductColor = productColorFor(selected, selectedProduct);
  const selectedMaxAmount = maxAmountForNozzle(selectedProduct);
  const selectedVolumeInvalid = selectedDraft?.mode === "volume" && !isValidVolume(selectedDraft.volume);
  const selectedAmountInvalid = selectedDraft?.mode === "amount" && !isValidAmount(selectedDraft.amount, selectedProduct);
  const selectedPositionActive = positionActiveByFp.get(selected.fp_id) ?? true;
  const selectedMeta = getMeta(selected, defaultAuthMode, selectedPositionActive);
  const selectedSetupLocked = selectedMeta.hasActivePreAuth || selectedMeta.isDelivering || selectedMeta.isAuthorizing || selectedMeta.isPaused;
  const selectedActiveReading = selectedMeta.isDelivering || selectedMeta.isAuthorizing || selectedMeta.isPaused;
  const selectedHasLastSale = !selectedActiveReading && selectedDraft?.lastFillVolume != null;
  const selectedDisplayVolume = selectedActiveReading
    ? (selectedMeta.paused?.stopped_volume ?? selected.volume)
    : (selectedDraft?.lastFillVolume ?? selected.volume);
  const selectedDisplayAmount = selectedActiveReading
    ? (selectedMeta.paused?.stopped_amount ?? selected.amount)
    : (selectedDraft?.lastFillAmount ?? selected.amount);
  const selectedMode = selectedDraft?.mode ?? "volume";
  const selectedModeLabel = selectedMode === "full"
    ? t("classic.full")
    : selectedMode === "amount"
      ? t("classic.amount")
      : t("classic.volume");
  const selectedColumnIndex = Math.max(0, states.findIndex((s) => s.fp_id === selected.fp_id));
  const selectedColumnRatio = selectedColumnIndex / states.length;
  const selectedColumnWidth = `calc(${100 / states.length}% - ${8 / states.length}rem)`;
  const selectedColumnLeft = `calc(${selectedColumnRatio * 100}% + ${8 - selectedColumnRatio * 8}rem)`;
  const centerCellClass = (fpId: string) =>
    fpId === selected.fp_id
      ? "relative z-10 bg-accent-blue/10 transition-colors duration-75"
      : "border-r border-border-primary/30 bg-bg-secondary/20 transition-colors duration-75";
  const centerHeaderClass = (fpId: string) =>
    fpId === selected.fp_id
      ? "relative z-10 bg-accent-blue/12 transition-colors duration-75"
      : "border-r border-border-primary/30 bg-bg-secondary/20 transition-colors duration-75";

  const renderPumpTile = (state: FpState) => {
    const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
    const draft = drafts[state.fp_id];
    const nozzle = selectedNozzle(state);
    const volumeUnit = volumeUnitFor(state, nozzle);
    const productColor = productColorFor(state, nozzle);
    const selectedCard = state.fp_id === selected.fp_id;
    const cardMismatch =
      preAuthNozzleMismatch != null && preAuthNozzleMismatch.fpId === state.fp_id;
    // Lifetime pump totals (Gilbarco GetTotals) for the CURRENTLY SELECTED product:
    // prefer the matching per-nozzle entry, falling back to the legacy single-nozzle
    // fields. The backend only ever populates these on Gilbarco fuel points, so the
    // null-check is the de-facto protocol gate (and hides the row on a Gilbarco pump 1
    // whose totals can't be decoded).
    const pumpTotalizer = pickPumpTotalizer(state, nozzle?.index ?? null);
    const showPumpTotalizer =
      pumpTotalizer != null && (meta.isIdle || meta.tag === "DONE" || meta.isPaused);
    const activeReading = meta.isDelivering || meta.isAuthorizing || meta.isPaused;
    const hasLastSale = !activeReading && draft?.lastFillVolume != null;
    const displayVolume = activeReading
      ? (meta.paused?.stopped_volume ?? state.volume)
      : (draft?.lastFillVolume ?? state.volume);
    const displayAmount = activeReading
      ? (meta.paused?.stopped_amount ?? state.amount)
      : (draft?.lastFillAmount ?? state.amount);
    return (
      <div
        key={state.fp_id}
        onMouseDown={(e) => handlePassivePumpMouseDown(state.fp_id, e)}
        className={`relative min-w-0 overflow-hidden rounded-none border text-left transition-[background-color,border-color,box-shadow] duration-75 ${
          selectedCard
            ? "z-20 border-accent-blue bg-bg-card ring-1 ring-inset ring-accent-blue"
            : "border-border-primary/40 bg-bg-secondary/30 hover:bg-bg-secondary/60 cursor-pointer"
        }`}
      >
        {/* Wrong-nozzle alert: a full-card RED overlay. Absolutely positioned so it
            never resizes the tile / shifts the grid, and pointer-events-none so the
            card underneath stays selectable. Pulsing ring + icon draw the operator's
            eye straight to the offending pump. */}
        {cardMismatch && (
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
        <button
          type="button"
          onClick={() => onSelectFp(state.fp_id)}
          ref={(el) => {
            if (el) pumpButtonRefs.current.set(state.fp_id, el);
            else pumpButtonRefs.current.delete(state.fp_id);
          }}
          onFocus={() => onSelectFp(state.fp_id)}
          onKeyDown={(e) => handlePumpKeyDown(state, e)}
          className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-blue focus-visible:ring-inset"
        >
          <div className={`flex items-center justify-between gap-2 border-b border-border-primary/25 ${ui.topCardPad} ${statusSolidClass(meta)}`}>
            <span className="flex min-w-0 items-center gap-2">
              <span className={`${ui.topCardText} shrink-0 font-semibold`}>{pumpNumber(state)}</span>
              <span className="line-clamp-2 min-w-0 break-words text-[11px] font-medium leading-tight text-text-secondary" title={pumpTitle(state)}>
                {pumpTitle(state)}
              </span>
            </span>
            <span className={`${dense ? "text-xs" : "text-sm"} min-w-0 truncate font-semibold uppercase`}>{classicStatusLabel(meta, t)}</span>
          </div>
          <div className={`grid grid-cols-2 bg-bg-primary/20 ${ui.topGridGap} ${ui.topCardPad} font-mono tabular-nums`}>
            {hasLastSale ? (
              <div className="col-span-2 -mb-1 text-[10px] font-medium text-text-muted">
                {t("dispenser.lastFill")}
              </div>
            ) : null}
            <div>
              <p className={`${ui.topCardLabel} font-medium text-text-muted`}>{t("classic.currentLiters")}</p>
              <p className={`truncate ${ui.topCardText} font-semibold text-text-primary`}>{displayVolume.toFixed(2)}</p>
            </div>
            <div className="text-right">
              <p className={`${ui.topCardLabel} font-medium text-text-muted`}>{t("classic.currentAmount")}</p>
              <p className={`truncate ${ui.topCardText} font-semibold text-accent-blue`}>{fmtSum.format(displayAmount)}</p>
            </div>
          </div>
        </button>
        <div
          className={`flex items-center justify-between border-l-2 border-t border-border-primary/20 bg-bg-secondary/20 ${ui.topGridGap} ${ui.topCardPad} ${ui.topCardLabel}`}
          style={{ borderLeftColor: productColor }}
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate font-black text-text-secondary">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-border-primary/40" style={{ backgroundColor: productColor }} />
            <span className="min-w-0 truncate">{nozzle?.product_name ?? state.product_name ?? "--"}</span>
            <span className="shrink-0 border-l border-border-primary pl-1.5 text-[10px] font-medium text-text-muted">
              {t("dispenser.nozzle")} {nozzle?.index ?? state.nozzle_index ?? "—"}
            </span>
          </span>
          <span className={`shrink-0 font-mono font-black ${ui.productPriceText}`} style={{ color: productColor }}>
            {fmtSum.format(nozzle?.price ?? state.price ?? 0)}
          </span>
        </div>
        {showPumpTotalizer && pumpTotalizer && (
          <div className={`flex items-center justify-between gap-2 border-t border-border-primary/20 bg-bg-secondary/10 px-3 py-1.5 font-mono tabular-nums ${ui.topCardLabel}`}>
            <span className="flex min-w-0 items-center gap-1 truncate font-extrabold uppercase tracking-wider text-text-muted">
              {t("dispenser.totalizer")}
              {pumpTotalizer.nozzleIndex != null ? ` · ${t("dispenser.nozzle")} ${pumpTotalizer.nozzleIndex}` : ""}
            </span>
            <span className="flex shrink-0 items-baseline gap-2">
              <span className="font-bold text-text-secondary">
                {pumpTotalizer.volume != null ? `${pumpTotalizer.volume.toFixed(2)} ${volumeUnit}` : "—"}
              </span>
              <span className="text-text-muted">
                {pumpTotalizer.amount != null ? fmtSum.format(pumpTotalizer.amount) : "—"}
              </span>
            </span>
          </div>
        )}
        <div className={`border-t border-border-primary/20 bg-bg-secondary/10 ${ui.topCardPad}`}>
          {renderAction(state, true)}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={consoleRef}
      onKeyDownCapture={handleConsoleKeyDownCapture}
      className="classic-console relative h-full min-h-0 w-full overflow-hidden rounded-none bg-bg-primary text-text-primary"
    >
      <div
        ref={contentRef}
        className={`absolute left-0 top-0 flex origin-top-left flex-col ${dense ? "gap-2" : "gap-3"}`}
        style={{
          transform: `scale(${scale})`,
          width: scale < 1 ? `${100 / scale}%` : "100%",
          height: "max-content",
        }}
      >
      <div
        className={`grid shrink-0 ${ui.topGridGap}`}
        style={{ gridTemplateColumns: `8rem repeat(${Math.min(Math.max(states.length, 1), 8)}, minmax(0, 1fr))` }}
      >
        <div className="hidden sm:flex flex-col items-center justify-center opacity-40 p-2 text-center text-[10px] font-bold uppercase tracking-widest text-text-muted">
           {/* Structural spacer to align pump cards with the table below */}
        </div>
        {states.map(renderPumpTile)}
      </div>

      <div className="relative overflow-hidden rounded border border-border-primary/50 bg-bg-card">
        <div
          className="pointer-events-none absolute bottom-0 top-0 z-20 border-2 border-accent-blue"
          style={{ left: selectedColumnLeft, width: selectedColumnWidth }}
          aria-hidden
        />
        <table className="w-full table-fixed border-collapse text-center text-xs" onMouseDown={handleTableMouseDown}>
          <colgroup>
            <col className="w-32" />
          </colgroup>
          <tbody className="divide-y divide-border-primary/30">
            <tr className="hover:bg-bg-primary/20 transition-colors duration-75">
              <th className={tableRowHeaderClass}>{t("classic.status")}</th>
              {states.map((state) => {
                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
                return (
                  <td key={state.fp_id} className={`${ui.tdPad} ${centerCellClass(state.fp_id)}`} data-fp-id={state.fp_id}>
                    <span className={`inline-flex w-full min-w-0 justify-center truncate rounded border ${ui.modeBtnPad} ${dense ? "text-xs" : "text-sm"} font-semibold uppercase ${statusSolidClass(meta)}`}>
                      {classicStatusLabel(meta, t)}
                    </span>
                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors duration-75">
              <th className={tableRowHeaderClass}>{t("classic.fuel")}</th>
	              {states.map((state) => {
	                const nozzles = (nozzlesByFp.get(state.fp_id) ?? []).filter((n) => n.active);
	                const draft = drafts[state.fp_id];
	                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
	                const setupLocked = meta.hasActivePreAuth || meta.isDelivering || meta.isAuthorizing || meta.isPaused;
	                const activeNozzle = nozzles.find((n) => n.index === draft?.nozzleIndex) ?? null;
	                const activeColor = productColorFor(state, activeNozzle);
	                return (
                  <td key={state.fp_id} className={`${ui.tdPad} ${centerCellClass(state.fp_id)}`} data-table-row="fuel" data-fp-id={state.fp_id}>
                    <div className="relative">
                      <span
                        className="pointer-events-none absolute left-2 top-1/2 z-[1] h-3 w-3 -translate-y-1/2 rounded-full border border-border-primary/40"
                        style={{ backgroundColor: activeColor }}
                        aria-hidden
                      />
	                      <select
	                        value={draft?.nozzleIndex ?? ""}
	                        disabled={nozzles.length <= 1 || setupLocked}
	                        onFocus={() => onSelectFp(state.fp_id)}
	                        onKeyDown={(e) => handleEditKeyDown(state, e)}
	                        onChange={(e) => {
	                          if (setupLocked) return;
	                          const nozzleIndex = e.target.value ? Number(e.target.value) : null;
	                          const nozzle = nozzles.find((n) => n.index === nozzleIndex);
	                          const draft = drafts[state.fp_id];
                          setDraft(state.fp_id, {
                            nozzleIndex,
                            ...relatedDraftValues(draft, nozzle ?? null),
                          });
                        }}
	                        className={`${ui.inputHeight} w-full rounded border ${ui.inputPad} pl-7 ${ui.inputText} font-semibold transition-[border-color,background-color] duration-75 outline-none disabled:cursor-not-allowed disabled:opacity-70 ${
	                          setupLocked
	                            ? lockedInputClass
	                            : "border-border-primary/40 bg-bg-input text-text-primary focus:border-accent-blue focus:ring-2 focus:ring-accent-blue/30 focus:ring-offset-0"
	                        }`}
                        style={{ boxShadow: `inset 0 3px 0 ${activeColor}` }}
                      >
                        {nozzles.length > 1 ? <option value="">--</option> : null}
                        {nozzles.map((n) => (
                          <option key={n.index} value={n.index}>{n.product_name}</option>
                        ))}
                      </select>
                    </div>
                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors duration-75">
              <th className={tableRowHeaderClass}>{t("classic.price")}</th>
              {states.map((state) => {
                const nozzle = selectedNozzle(state);
                const productColor = productColorFor(state, nozzle);
                return (
                  <td key={state.fp_id} className={`${ui.tdPad} font-mono ${ui.priceText} font-black ${centerCellClass(state.fp_id)}`} data-fp-id={state.fp_id}>
                    <span style={{ color: productColor }}>{fmtSum.format(nozzle?.price ?? state.price ?? 0)}</span>
                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors duration-75">
              <th className={tableRowHeaderClass}>{t("classic.orderLiters")}</th>
	              {states.map((state) => {
	                const draft = drafts[state.fp_id];
	                const volumeUnit = volumeUnitFor(state);
	                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
	                const setupLocked = meta.hasActivePreAuth || meta.isDelivering || meta.isAuthorizing || meta.isPaused;
	                const invalid = draft?.mode === "volume" && !isValidVolume(draft.volume);
	                return (
	                  <td key={state.fp_id} className={`${ui.tdPad} ${centerCellClass(state.fp_id)}`} data-table-row="volume" data-fp-id={state.fp_id}>
	                    <div className="flex min-w-0 items-stretch">
	                      <input
                        type="text"
                        inputMode="decimal"
                        aria-invalid={invalid}
	                        title={`1-${MAX_VOLUME_LITERS} ${volumeUnit}`}
	                        placeholder="—"
	                        value={draft?.volume ?? ""}
	                        disabled={setupLocked}
	                        onFocus={(e) => {
	                          onSelectFp(state.fp_id);
	                          setDraft(state.fp_id, { mode: "volume" });
	                          selectInputValue(e.currentTarget);
	                        }}
                        onMouseUp={(e) => e.preventDefault()}
                        onChange={(e) => updateVolume(state, e.target.value)}
                        onKeyDown={(e) => handleEditKeyDown(state, e)}
	                        className={`${ui.inputHeight} min-w-0 flex-1 rounded border ${dense ? "px-2" : "px-4"} text-center ${ui.inputText} font-mono font-semibold tabular-nums transition-[border-color,background-color] duration-75 outline-none disabled:cursor-not-allowed ${centerOrderFocusClass} ${
	                          setupLocked
	                            ? lockedInputClass
	                            : invalid
	                            ? invalidInputClass
	                            : draft?.mode === "volume"
                              ? selectedOrderInputClass
                              : "border-border-primary/40 bg-bg-input text-text-primary focus:ring-accent-blue/30 focus:border-accent-blue"
                        }`}
                      />
	                      <span aria-hidden className={`${ui.inputHeight} -ml-px flex ${tableUnitSlotClass} ${centerUnitClass} items-center justify-center border border-border-primary/40 bg-bg-secondary/80`}>
	                        {volumeUnit}
	                      </span>
                    </div>
                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors duration-75">
              <th className={tableRowHeaderClass}>{t("classic.orderAmount")}</th>
              {states.map((state) => {
	                const draft = drafts[state.fp_id];
	                const nozzle = selectedNozzle(state);
	                const maxAmount = maxAmountForNozzle(nozzle);
	                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
	                const setupLocked = meta.hasActivePreAuth || meta.isDelivering || meta.isAuthorizing || meta.isPaused;
	                const invalid = draft?.mode === "amount" && !isValidAmount(draft.amount, nozzle);
	                return (
	                  <td key={state.fp_id} className={`${ui.tdPad} ${centerCellClass(state.fp_id)}`} data-table-row="amount" data-fp-id={state.fp_id}>
	                    <div className="flex min-w-0 items-stretch">
	                      <input
                        type="text"
                        inputMode="numeric"
                        aria-invalid={invalid}
	                        title={`1-${fmtSum.format(maxAmount)}`}
	                        placeholder="—"
	                        value={draft?.amount ?? ""}
	                        disabled={setupLocked}
	                        onFocus={(e) => {
	                          onSelectFp(state.fp_id);
	                          setDraft(state.fp_id, { mode: "amount" });
	                          selectInputValue(e.currentTarget);
	                        }}
                        onMouseUp={(e) => e.preventDefault()}
                        onChange={(e) => updateAmount(state, e.target.value)}
                        onKeyDown={(e) => handleEditKeyDown(state, e)}
	                        className={`${ui.inputHeight} min-w-0 flex-1 rounded border ${dense ? "px-2" : "px-4"} text-center ${ui.inputText} font-mono font-semibold tabular-nums transition-[border-color,background-color] duration-75 outline-none disabled:cursor-not-allowed ${centerOrderFocusClass} ${
	                          setupLocked
	                            ? lockedInputClass
	                            : invalid
	                            ? invalidInputClass
	                            : draft?.mode === "amount"
                              ? selectedOrderInputClass
                              : "border-border-primary/40 bg-bg-input text-text-primary focus:ring-accent-blue/30 focus:border-accent-blue"
                        }`}
                      />
	                      <span aria-hidden className={`${ui.inputHeight} -ml-px flex ${tableUnitSlotClass} ${centerUnitClass} items-center justify-center border border-border-primary/40 bg-bg-secondary/80`}>
	                        SO'M
	                      </span>
                    </div>
                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors duration-75">
              <th className={tableRowHeaderClass}>{t("classic.mode")}</th>
              {states.map((state) => (
                <td key={state.fp_id} className={`${ui.tdPad} ${centerCellClass(state.fp_id)}`} data-table-row="mode" data-fp-id={state.fp_id}>{renderModeButtons(state, true)}</td>
              ))}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors duration-75">
              <th className={tableRowHeaderClass}>{t("classic.currentLiters")}</th>
              {states.map((state) => {
                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
                const volumeUnit = volumeUnitFor(state);
                const draft = drafts[state.fp_id];
                const isActive = meta.isDelivering || meta.isAuthorizing;
                const displayVol = isActive
                  ? (meta.paused?.stopped_volume ?? state.volume)
                  : (draft?.lastFillVolume ?? state.volume);
                return (
	                  <td key={state.fp_id} className={`${ui.tdPad} font-mono font-black tabular-nums ${ui.tableLiveText} ${centerCellClass(state.fp_id)}`} data-fp-id={state.fp_id}>
	                    <span className="inline-flex items-baseline justify-center gap-2">
	                      <span>{displayVol.toFixed(2)}</span>
	                      <span className={centerValueUnitClass}>{volumeUnit}</span>
	                    </span>
	                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors duration-75">
              <th className={tableRowHeaderClass}>{t("classic.currentAmount")}</th>
              {states.map((state) => {
                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
                const draft = drafts[state.fp_id];
                const isActive = meta.isDelivering || meta.isAuthorizing;
                const displayAmt = isActive
                  ? (meta.paused?.stopped_amount ?? state.amount)
                  : (draft?.lastFillAmount ?? state.amount);
                return (
	                  <td key={state.fp_id} className={`${ui.tdPad} font-mono font-black tabular-nums ${ui.tableLiveText} text-accent-blue ${centerCellClass(state.fp_id)}`} data-fp-id={state.fp_id}>
	                    <span className="inline-flex items-baseline justify-center gap-2">
	                      <span>{fmtSum.format(displayAmt)}</span>
	                      <span className={centerValueUnitClass}>SO'M</span>
	                    </span>
	                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors duration-75">
              <th className={tableRowHeaderClass}>{t("classic.remaining")}</th>
              {states.map((state) => {
                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
                const draft = drafts[state.fp_id];
                const volumeUnit = volumeUnitFor(state);
                const isActive = meta.isDelivering || meta.isAuthorizing;
                let cell = <span className="text-text-muted/50">—</span>;
                if (isActive) {
                  const volTarget = parseVolumeTarget(state.pre_auth_preset);
                  const amtTarget = parseAmountTarget(state.pre_auth_preset);
                  if (volTarget != null) {
                    const rem = Math.max(0, volTarget - state.volume);
                    cell = <span className="inline-flex items-baseline gap-2 text-accent-amber"><span>{rem.toFixed(2)}</span><span className={centerValueUnitClass}>{volumeUnit}</span></span>;
                  } else if (amtTarget != null) {
                    const rem = Math.max(0, amtTarget - state.amount);
                    cell = <span className="inline-flex items-baseline gap-2 text-accent-amber"><span>{fmtSum.format(rem)}</span><span className={centerValueUnitClass}>SO'M</span></span>;
                  }
                } else if (draft?.lastFillPreset != null) {
                  const volTarget = parseVolumeTarget(draft.lastFillPreset);
                  const amtTarget = parseAmountTarget(draft.lastFillPreset);
                  if (volTarget != null && draft.lastFillVolume != null) {
                    const rem = Math.max(0, volTarget - draft.lastFillVolume);
                    cell = <span className="inline-flex items-baseline gap-2 text-text-muted/70"><span>{rem.toFixed(2)}</span><span className={centerValueUnitClass}>{volumeUnit}</span></span>;
                  } else if (amtTarget != null && draft.lastFillAmount != null) {
                    const rem = Math.max(0, amtTarget - draft.lastFillAmount);
                    cell = <span className="inline-flex items-baseline gap-2 text-text-muted/70"><span>{fmtSum.format(rem)}</span><span className={centerValueUnitClass}>SO'M</span></span>;
                  }
                }
                return (
	                  <td key={state.fp_id} className={`${ui.tdPad} font-mono font-black tabular-nums ${ui.topCardText} ${centerCellClass(state.fp_id)}`} data-fp-id={state.fp_id}>
	                    {cell}
	                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <div
        ref={bottomPanelRef}
        className="shrink-0 overflow-hidden rounded border border-border-primary/60 bg-bg-card transition-[background-color,border-color] duration-75"
      >
        <div className={`flex flex-col border-b border-border-primary/30 ${ui.topCardPad} ${statusTintClass(selectedMeta)} bg-opacity-40`}>
          <div className="flex flex-wrap items-center justify-between">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <p className={`min-w-0 truncate ${ui.inputText} font-black uppercase tracking-wider text-text-primary`}>
                  {t("classic.selectedPump")}: <span className="text-accent-blue">{pumpTitle(selected)}</span>
                </p>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded border border-accent-blue bg-accent-blue px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white">
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  {t("classic.mode")}: {selectedModeLabel}
                </span>
              </div>
              <p className={`flex items-center gap-2 ${dense ? "text-sm" : "text-base"} font-semibold opacity-90`}>
                <span>{t("classic.liveStatus")}: {classicStatusLabel(selectedMeta, t)}</span>
                <span className="h-1 w-1 rounded-full bg-current opacity-50" aria-hidden />
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full border border-border-primary/40" style={{ backgroundColor: selectedProductColor }} />
                  <span className="truncate">{selectedProduct?.product_name ?? selected.product_name ?? "--"}</span>
                </span>
              </p>
            </div>
            <div className={`flex ${dense ? "gap-5" : "gap-8"} text-right font-mono tabular-nums`}>
              <div>
                <p className={`${ui.thText} font-semibold uppercase tracking-wide opacity-70`}>
                  {selectedHasLastSale ? `${t("dispenser.lastFill")} · ` : ""}{t("classic.currentLiters")}
                </p>
                <p className={`font-mono ${ui.bottomLiveText} font-semibold tabular-nums`}>{selectedDisplayVolume.toFixed(2)}</p>
              </div>
              <div>
                <p className={`${ui.thText} font-semibold uppercase tracking-wide opacity-70`}>
                  {selectedHasLastSale ? `${t("dispenser.lastFill")} · ` : ""}{t("classic.currentAmount")}
                </p>
                <p className={`font-mono ${ui.bottomLiveText} font-semibold tabular-nums text-accent-blue`}>{fmtSum.format(selectedDisplayAmount)}</p>
              </div>
            </div>
          </div>
          {/* Always-present progress track — fixed height so the panel never shifts */}
          {(() => {
            const delivering = selectedMeta.isDelivering || selectedMeta.isAuthorizing;
            const vt = delivering ? parseVolumeTarget(selected.pre_auth_preset) : null;
            const at = delivering ? parseAmountTarget(selected.pre_auth_preset) : null;
            const liveVolume = selectedMeta.paused?.stopped_volume ?? selected.volume;
            const liveAmount = selectedMeta.paused?.stopped_amount ?? selected.amount;
            const estimatedAmount =
              liveAmount > 0
                ? liveAmount
                : selectedProduct?.price && selectedProduct.price > 0
                  ? Math.round(liveVolume * selectedProduct.price)
                  : 0;
            const pct = vt != null && vt > 0
              ? Math.min(100, (liveVolume / vt) * 100)
              : at != null && at > 0
                ? Math.min(100, (estimatedAmount / at) * 100)
                : 0;
            return (
              <div className="mt-2 h-1.5 w-full overflow-hidden bg-bg-secondary/60">
                <div
                  className="h-full bg-accent-amber transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            );
          })()}
        </div>
        <div className={`grid ${ui.topGridGap} ${ui.topCardPad} lg:grid-cols-[1.1fr_minmax(0,1fr)_minmax(0,1fr)_minmax(16rem,16rem)]`}>
	          <div className={`min-w-0 ${bottomControlWrapClass}`}>
	            <label className={bottomLabelClass}>{t("classic.fuel")}</label>
	            <div
	              data-classic-control="fuel"
	              tabIndex={selectedNozzles.length > 0 && !selectedSetupLocked ? 0 : -1}
	              onKeyDown={(e) => {
	                if (selectedSetupLocked) {
	                  handleEditKeyDown(selected, e);
	                  return;
	                }
	                if (e.key === " ") {
	                  e.preventDefault();
                  if (selectedNozzles.length > 1) {
                    const currentIndex = selectedNozzles.findIndex((n) => n.index === selectedDraft?.nozzleIndex);
                    const next = selectedNozzles[(currentIndex + 1) % selectedNozzles.length];
                    if (next) setDraft(selected.fp_id, { nozzleIndex: next.index });
                  }
                } else {
                  handleEditKeyDown(selected, e);
                }
              }}
	              className={`flex min-h-0 w-full flex-1 gap-1 rounded border border-border-primary/40 p-1 outline-none transition-[border-color,background-color,opacity] duration-75 ${
	                selectedSetupLocked
	                  ? "cursor-not-allowed bg-bg-secondary/40 opacity-70"
	                  : `bg-bg-input/60 ${focusControlClass} ${selectedNozzles.length <= 1 ? "opacity-80" : "cursor-pointer"}`
	              }`}
	            >
              {selectedNozzles.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-xs font-bold tracking-wide text-text-muted">
                  {t("classic.noActiveProducts")}
                </div>
              ) : (
                selectedNozzles.map((n) => {
                  const isActive = selectedDraft?.nozzleIndex === n.index;
                  return (
                    <button
	                      key={n.index}
	                      type="button"
	                      tabIndex={-1}
	                      disabled={selectedSetupLocked}
	                      onClick={(e) => {
	                        if (selectedSetupLocked) return;
	                        e.stopPropagation();
	                        setDraft(selected.fp_id, {
                          nozzleIndex: n.index,
                          ...relatedDraftValues(selectedDraft, n),
                        });
                        e.currentTarget.parentElement?.focus();
                      }}
	                      className={`flex-1 flex flex-col justify-center items-center min-h-0 min-w-0 rounded-none transition-[background-color,border-color,box-shadow,color] duration-75 outline-none disabled:cursor-not-allowed ${
	                        isActive
	                          ? "border text-white"
	                          : "border border-transparent bg-transparent text-text-primary hover:bg-bg-secondary"
                      }`}
                      style={isActive ? { backgroundColor: n.product_color, borderColor: n.product_color } : undefined}
                    >
                      <span
                        className={`mb-1 h-1.5 w-8 rounded-full ${isActive ? "bg-white/80" : ""}`}
                        style={!isActive ? { backgroundColor: n.product_color } : undefined}
                        aria-hidden
                      />
                      <span className={`font-black uppercase tracking-wider truncate px-1 w-full text-center ${ui.inputText}`}>
                        {n.product_name}
                      </span>
                      <span
                        className={`w-full truncate px-1 text-center font-mono ${ui.productPriceText} font-bold opacity-90`}
                        style={!isActive ? { color: n.product_color } : undefined}
                      >
                        {fmtSum.format(n.price)}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
          <div className={`${bottomControlWrapClass} ${selectedMode === "volume" ? "!border-2 !border-accent-blue bg-accent-blue/15 opacity-100" : "opacity-50"}`}>
            {selectedMode === "volume" ? (
              <label className="mb-1 flex items-center justify-between rounded bg-accent-blue px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white">
                <span>{t("classic.orderLiters")}</span>
                <Check className="h-4 w-4" aria-hidden />
              </label>
            ) : (
              <label className={bottomLabelClass}>{t("classic.orderLiters")}</label>
            )}
            <div className="flex-1 min-h-0">
              <input
                data-classic-control="volume"
                type="text"
                inputMode="decimal"
                aria-invalid={selectedVolumeInvalid}
	                title={`1-${MAX_VOLUME_LITERS} ${selectedVolumeUnit}`}
	                placeholder="—"
	                value={selectedDraft?.volume ?? ""}
	                disabled={selectedSetupLocked}
	                onChange={(e) => updateVolume(selected, e.target.value)}
                onFocus={(e) => {
                  setDraft(selected.fp_id, { mode: "volume" });
                  selectInputValue(e.currentTarget);
                }}
                onMouseUp={(e) => e.preventDefault()}
                onKeyDown={(e) => handleEditKeyDown(selected, e)}
	                className={`h-full min-h-0 w-full rounded border ${ui.inputPad} text-center font-mono ${dense ? "text-2xl" : "text-3xl"} font-semibold outline-none disabled:cursor-not-allowed ${
	                  selectedSetupLocked
	                    ? lockedInputClass
	                    : selectedVolumeInvalid
	                    ? invalidInputClass
	                    : selectedMode === "volume"
	                      ? `${selectedOrderInputClass} ${focusControlClass}`
	                      : `border-border-primary/40 bg-bg-input/60 text-text-primary ${focusControlClass}`
	                }`}
              />
            </div>
            <span className={`text-[10px] font-bold ${selectedVolumeInvalid ? "text-accent-red" : "text-text-muted"}`}>
              1-{MAX_VOLUME_LITERS} {selectedVolumeUnit}
            </span>
          </div>
          <div className={`${bottomControlWrapClass} ${selectedMode === "amount" ? "!border-2 !border-accent-blue bg-accent-blue/15 opacity-100" : "opacity-50"}`}>
            {selectedMode === "amount" ? (
              <label className="mb-1 flex items-center justify-between rounded bg-accent-blue px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white">
                <span>{t("classic.orderAmount")}</span>
                <Check className="h-4 w-4" aria-hidden />
              </label>
            ) : (
              <label className={bottomLabelClass}>{t("classic.orderAmount")}</label>
            )}
            <div className="flex-1 min-h-0">
              <input
                data-classic-control="amount"
                type="text"
                inputMode="numeric"
                aria-invalid={selectedAmountInvalid}
	                title={`1-${fmtSum.format(selectedMaxAmount)}`}
	                placeholder="—"
	                value={selectedDraft?.amount ?? ""}
	                disabled={selectedSetupLocked}
	                onChange={(e) => updateAmount(selected, e.target.value)}
                onFocus={(e) => {
                  setDraft(selected.fp_id, { mode: "amount" });
                  selectInputValue(e.currentTarget);
                }}
                onMouseUp={(e) => e.preventDefault()}
                onKeyDown={(e) => handleEditKeyDown(selected, e)}
	                className={`h-full min-h-0 w-full rounded border ${ui.inputPad} text-center font-mono ${dense ? "text-2xl" : "text-3xl"} font-semibold outline-none disabled:cursor-not-allowed ${
	                  selectedSetupLocked
	                    ? lockedInputClass
	                    : selectedAmountInvalid
	                    ? invalidInputClass
	                    : selectedMode === "amount"
	                      ? `${selectedOrderInputClass} ${focusControlClass}`
	                      : `border-border-primary/40 bg-bg-input/60 text-text-primary ${focusControlClass}`
	                }`}
              />
            </div>
            <span className={`text-[10px] font-bold ${selectedAmountInvalid ? "text-accent-red" : "text-text-muted"}`}>
              1-{fmtSum.format(selectedMaxAmount)}
            </span>
          </div>
          <div className={`${bottomControlWrapClass} flex min-w-0 flex-col justify-end gap-3`}>
            <span className={bottomLabelClass}>{t("classic.mode")}</span>
            {renderModeButtons(selected, false, false)}
            <div className="mt-1 flex" data-classic-control="action" onKeyDown={(e) => handleControlNavKeyDown(selected, e)}>
              {renderAction(selected)}
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
