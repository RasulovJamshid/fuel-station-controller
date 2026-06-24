import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pausedInfo, statusTag } from "../types/api";
import type { AuthMode, FpState, FpStatus, NozzleSnapshot } from "../types/api";
import type { AuthorizeRequest, FillMode } from "./DispenserCard";
import { useAppStore } from "../store";
const fmtSum = new Intl.NumberFormat("uz-UZ");
const MAX_VOLUME_LITERS = 999;

function parseVolumeTarget(preset: string | null | undefined): number | null {
  if (!preset) return null;
  const m = preset.match(/([\d.,]+)\s*L/i);
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
  return raw.replace(/\D/g, "").slice(0, 9);
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
    const amount = parseNum(draft.amount);
    if (amount > 0) {
      return { volume: String(Math.round((amount / nozzle.price) * 10) / 10) };
    }
  }

  if (draft.mode === "volume") {
    const volume = parseNum(draft.volume);
    if (volume > 0) {
      return { amount: String(Math.round(volume * nozzle.price)) };
    }
  }

  return {};
}

function selectInputValue(input: HTMLInputElement) {
  window.requestAnimationFrame(() => input.select());
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
  isContinuing: boolean;
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
  onResumeFill: (fpId: string, stoppedTxId: string) => void;
  onContinueFill: (fpId: string, stoppedTxId: string) => void;
  onCloseStopped: (fpId: string, stoppedTxId: string) => void;
  shiftRequired?: boolean;
  onStartShift?: () => void;
  useStopMode?: boolean;
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
  const isContinuing = (state.base_volume ?? 0) > 0 && (isDelivering || isAuthorizing);
  const canOpenPreAuth =
    (isIdle || isNozzleUp) &&
    defaultAuthMode === "preauth" &&
    !isPaused &&
    !isContinuing &&
    !hasActivePreAuth;
  const canOpenReactive =
    isNozzleUp &&
    defaultAuthMode !== "preauth" &&
    !isPaused &&
    !isContinuing &&
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
    isContinuing,
    canAuthorize: positionActive && !isOffline && (canOpenPreAuth || canOpenReactive),
  };
}

function statusTintClass(meta: PumpMeta): string {
  if (meta.isOffline) return "border-accent-red/40 bg-accent-red/10 text-accent-red shadow-[inset_0_0_20px_rgba(var(--color-accent-red),0.05)]";
  if (meta.isDelivering || meta.isAuthorizing) return "border-accent-emerald/40 bg-accent-emerald/10 text-accent-emerald shadow-[inset_0_0_20px_rgba(var(--color-accent-emerald),0.05)]";
  if (meta.hasActivePreAuth || meta.isPaused) return "border-accent-amber/40 bg-accent-amber/10 text-accent-amber shadow-[inset_0_0_20px_rgba(var(--color-accent-amber),0.05)]";
  if (meta.isNozzleUp) return "border-accent-blue/40 bg-accent-blue/10 text-accent-blue shadow-[inset_0_0_20px_rgba(var(--color-accent-blue),0.05)]";
  return "border-border-primary/50 bg-bg-secondary/40 text-text-secondary backdrop-blur-sm";
}

function statusSolidClass(meta: PumpMeta): string {
  if (meta.isOffline) return "border-accent-red bg-accent-red text-white";
  if (meta.isDelivering || meta.isAuthorizing) return "border-accent-emerald bg-accent-emerald text-white";
  if (meta.hasActivePreAuth || meta.isPaused) return "border-accent-amber bg-accent-amber text-white";
  if (meta.isNozzleUp) return "border-accent-blue bg-accent-blue text-white";
  return "border-border-primary/50 bg-bg-secondary/80 text-text-secondary";
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
  onResumeFill,
  onContinueFill,
  onCloseStopped,
  shiftRequired = false,
  onStartShift,
  useStopMode = false,
  useCancelMode = false,
  gilbarcoMode = false,
}: Props) {
  const { t } = useTranslation();
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
  const [activeOrderField, setActiveOrderField] = useState<{ fpId: string; field: OrderField } | null>(null);
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

  // Use the premium, highly readable style tokens. The scaling engine handles small screens!
  const ui = {
    topGridGap: "gap-2",
    topCardPad: "p-3",
    topCardText: "text-xl",
    topCardLabel: "text-sm",
    
    thPad: "px-4 py-3",
    tdPad: "px-3 py-2",
    thText: "text-xs",
    
    inputHeight: "h-12",
    inputText: "text-2xl",
    inputPad: "px-4",
    
    modeBtnPad: "px-3 py-2",
    modeBtnText: "text-base",
    
    btnHeight: "h-10",
    btnPad: "px-4",
    btnText: "text-sm",
  };

  const focusControlClass =
    "transition-all duration-200 focus:border-accent-blue focus:bg-bg-primary focus:ring-[4px] focus:ring-accent-blue/30 focus:ring-offset-0 focus:outline-none shadow-sm focus:shadow-md";
  const invalidInputClass =
    "border-accent-red/70 bg-accent-red/10 text-text-primary focus:border-accent-red focus:ring-accent-red/30";
  const lockedInputClass =
    "cursor-not-allowed border-border-primary/30 bg-bg-secondary/40 text-text-muted opacity-70";
  const mirroredOrderInputClass =
    "border-2 border-accent-blue bg-accent-blue/15 ring-[5px] ring-accent-blue/35 shadow-[0_0_0_1px_rgba(var(--color-accent-blue),0.55),0_10px_24px_-12px_rgba(var(--color-accent-blue),0.9)]";
  const centerOrderFocusClass =
    "focus:bg-accent-blue/20 focus:ring-[7px] focus:ring-accent-blue/45 focus:shadow-[0_0_0_2px_rgba(var(--color-accent-blue),0.75),0_12px_28px_-10px_rgba(var(--color-accent-blue),0.95)]";
  const bottomControlWrapClass =
    "group flex flex-col gap-1 rounded-none border border-border-primary/50 bg-bg-secondary/20 p-3 transition-colors duration-100 hover:bg-bg-secondary/40 hover:shadow-md focus-within:border-accent-blue focus-within:bg-accent-blue/5 focus-within:shadow-[0_8px_24px_-8px_rgba(var(--color-accent-blue),0.4)]";
  const bottomLabelClass =
    "mb-1 block text-sm font-black uppercase tracking-wider text-text-secondary transition-colors duration-200 group-focus-within:text-accent-blue group-hover:text-text-primary";
  const tableUnitSlotClass = "w-14 shrink-0";

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
        // An armed setup (pre-auth) or a bare nozzle-up that drops back to IDLE without
        // fueling — e.g. a wrong-nozzle pre-auth mismatch that cancels and returns to
        // idle once the wrong nozzle is holstered. The old volume/amount from that
        // pre-auth must not linger in the inputs.
        const setupAbandoned =
          (prevTag === "PRE_AUTHORIZED" || prevTag === "NOZZLE_UP") && tag === "IDLE";
        // Clear inputs after a successful fill (status hits DONE, or DONE was skipped and
        // we jump straight from an active state to IDLE) OR when a setup was abandoned.
        const clearValues = tag === "DONE" || (wasActive && tag === "IDLE") || setupAbandoned;
        // Capture last-fill snapshot when the fill just ended.
        const captureLastFill = clearValues && state.volume > 0;
        // Reset last-fill snapshot when a new transaction begins.
        const clearLastFill = tag === "NOZZLE_UP" || tag === "AUTHORIZING" || tag === "DELIVERING";
        next[state.fp_id] = {
          nozzleIndex,
          mode: prevDraft?.mode ?? "volume",
          volume: clearValues ? "" : (prevDraft?.volume ?? ""),
          amount: clearValues ? "" : (prevDraft?.amount ?? ""),
          lastFillVolume: clearLastFill ? null : captureLastFill ? state.volume : (prevDraft?.lastFillVolume ?? null),
          lastFillAmount: clearLastFill ? null : captureLastFill ? state.amount : (prevDraft?.lastFillAmount ?? null),
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
    setActiveOrderField({ fpId, field });
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
    setActiveOrderField({ fpId, field });
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
      amount: nextRaw === "" ? "" : nozzle?.price && liters > 0 ? String(Math.round(liters * nozzle.price)) : drafts[state.fp_id]?.amount,
    });
  }, [defaultAuthMode, drafts, positionActiveByFp, selectedNozzle, setDraft]);

  const updateAmount = useCallback((state: FpState, raw: string) => {
    const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
    if (meta.hasActivePreAuth || meta.isDelivering || meta.isAuthorizing || meta.isPaused) return;
    const nextRaw = sanitizeAmountInput(raw);
    const nozzle = selectedNozzle(state);
    const amount = parseNum(nextRaw);
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

    // Prevent hijacking ArrowLeft/ArrowRight when editing text inputs
    const isInput = target?.tagName === "INPUT" && (target as HTMLInputElement).type === "text";
    if (isInput && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      return;
    }

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
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

      const root = consoleRef.current;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const focusedElement = target ?? activeElement;

      if (root && focusedElement && root.contains(focusedElement)) return;
      if (
        focusedElement &&
        (focusedElement.matches("input, textarea, select") || focusedElement.isContentEditable)
      ) {
        return;
      }

      const selectedState = activeState ?? states[0];
      if (!selectedState) return;

      event.preventDefault();
      selectPumpByOffset(selectedState.fp_id, event.key === "ArrowRight" ? 1 : -1);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [activeState, selectPumpByOffset, states]);

  const renderAction = (state: FpState, compact = false) => {
    const positionActive = positionActiveByFp.get(state.fp_id) ?? true;
    const meta = getMeta(state, defaultAuthMode, positionActive);
    const paused = meta.paused;
    const baseClass = `${ui.btnHeight} ${ui.btnPad} ${ui.btnText} rounded-none`;
    const cls = `${baseClass} w-full flex-1 font-black uppercase tracking-wider outline-none transition-colors duration-200 active:brightness-95 focus-visible:ring-[3px] focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none`;

    if (meta.canAuthorize) {
      return (
        <button
          type="button"
          disabled={!shiftRequired && !buildRequest(state)}
          onClick={() => startPump(state)}
          className={`${cls} border border-accent-emerald/80 bg-accent-emerald text-white hover:bg-accent-emerald-light shadow-[0_4px_12px_rgba(var(--color-accent-emerald),0.2)] focus-visible:ring-accent-emerald/30`}
        >
          {shiftRequired ? t("classic.startShift") : t("classic.start")}
        </button>
      );
    }
    if (meta.isDelivering || meta.isAuthorizing) {
      return (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => onStop(state.fp_id)}
            className={`${cls} border border-accent-amber/80 bg-accent-amber text-white hover:bg-accent-amber-light shadow-[0_4px_12px_rgba(var(--color-accent-amber),0.2)] focus-visible:ring-accent-amber/30`}
          >
            {useStopMode || gilbarcoMode ? t("classic.stop") : t("classic.pause")}
          </button>
          {useCancelMode && onCancel && !gilbarcoMode ? (
            <button
              type="button"
              onClick={() => onCancel(state.fp_id)}
              className={`${cls} border border-accent-red/80 bg-accent-red text-white hover:bg-accent-red-light shadow-[0_4px_12px_rgba(var(--color-accent-red),0.2)] focus-visible:ring-accent-red/30`}
            >
              {t("classic.cancel")}
            </button>
          ) : null}
        </div>
      );
    }
    if (meta.hasActivePreAuth && !meta.isDelivering && !meta.isPaused) {
      return (
        <button
          type="button"
          onClick={() => onCancelPreAuth?.(state.fp_id)}
          className={`${cls} border border-border-primary bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary hover:border-text-primary/20 focus-visible:ring-text-primary/20`}
        >
          {t("classic.cancelPreAuth")}
        </button>
      );
    }
    if (paused) {
      if (gilbarcoMode || paused.stop_source === "APP_FINAL") {
        return (
          <button
            type="button"
            onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
            className={`${cls} border border-border-primary bg-bg-tertiary text-text-primary hover:bg-bg-secondary hover:border-text-primary/20 focus-visible:ring-text-primary/20`}
          >
            {t("classic.close")}
          </button>
        );
      }
      if (paused.stop_source === "APP") {
        return (
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => onResumeFill(state.fp_id, paused.stopped_tx_id)}
              className={`${cls} border border-accent-emerald/80 bg-accent-emerald text-white hover:bg-accent-emerald-light shadow-[0_4px_12px_rgba(var(--color-accent-emerald),0.2)] focus-visible:ring-accent-emerald/30`}
            >
              {t("classic.resume")}
            </button>
            <button
              type="button"
              onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
              className={`${cls} border border-border-primary bg-bg-tertiary text-text-primary hover:bg-bg-secondary hover:border-text-primary/20 focus-visible:ring-text-primary/20`}
            >
              {t("classic.close")}
            </button>
          </div>
        );
      }
      return (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => onContinueFill(state.fp_id, paused.stopped_tx_id)}
            className={`${cls} border border-accent-emerald/80 bg-accent-emerald text-white hover:bg-accent-emerald-light shadow-[0_4px_12px_rgba(var(--color-accent-emerald),0.2)] focus-visible:ring-accent-emerald/30`}
          >
            {t("classic.continue")}
          </button>
          <button
            type="button"
            onClick={() => onCloseStopped(state.fp_id, paused.stopped_tx_id)}
            className={`${cls} border border-border-primary bg-bg-tertiary text-text-primary hover:bg-bg-secondary hover:border-text-primary/20 focus-visible:ring-text-primary/20`}
          >
            {t("classic.close")}
          </button>
        </div>
      );
    }
    return <div className={`${ui.btnHeight} flex items-center justify-center`}><span className="text-[11px] font-bold tracking-wider text-text-muted/60 uppercase">--</span></div>;
  };

  const renderModeButtons = (state: FpState, compact = false, keyboardControls = false) => {
    const draft = drafts[state.fp_id];
    const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
    const setupLocked = meta.hasActivePreAuth || meta.isDelivering || meta.isAuthorizing || meta.isPaused;
    const modes: FillMode[] = ["full", "volume", "amount"];
    const modeColorClass = (mode: FillMode, active: boolean) => {
      if (mode === "full") {
        return active
          ? "border-2 border-white/70 bg-accent-emerald text-white shadow-[inset_0_0_0_2px_rgba(255,255,255,0.22),0_0_0_2px_rgba(var(--color-accent-emerald),0.45),0_10px_20px_-12px_rgba(var(--color-accent-emerald),0.95)] hover:bg-accent-emerald active:bg-accent-emerald focus:bg-accent-emerald focus:text-white focus-visible:ring-accent-emerald/35"
          : "border border-accent-emerald/25 bg-accent-emerald/10 text-accent-emerald hover:bg-accent-emerald/18 hover:text-accent-emerald active:bg-accent-emerald/22 focus:bg-accent-emerald/18 focus:text-accent-emerald focus-visible:ring-accent-emerald/30";
      }
      if (mode === "volume") {
        return active
          ? "border-2 border-white/70 bg-accent-blue text-white shadow-[inset_0_0_0_2px_rgba(255,255,255,0.22),0_0_0_2px_rgba(var(--color-accent-blue),0.45),0_10px_20px_-12px_rgba(var(--color-accent-blue),0.95)] hover:bg-accent-blue active:bg-accent-blue focus:bg-accent-blue focus:text-white focus-visible:ring-accent-blue/35"
          : "border border-accent-blue/25 bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/18 hover:text-accent-blue active:bg-accent-blue/22 focus:bg-accent-blue/18 focus:text-accent-blue focus-visible:ring-accent-blue/30";
      }
      return active
        ? "border-2 border-white/70 bg-accent-amber text-white shadow-[inset_0_0_0_2px_rgba(255,255,255,0.22),0_0_0_2px_rgba(var(--color-accent-amber),0.45),0_10px_20px_-12px_rgba(var(--color-accent-amber),0.95)] hover:bg-accent-amber active:bg-accent-amber focus:bg-accent-amber focus:text-white focus-visible:ring-accent-amber/35"
        : "border border-accent-amber/25 bg-accent-amber/10 text-accent-amber hover:bg-accent-amber/18 hover:text-accent-amber active:bg-accent-amber/22 focus:bg-accent-amber/18 focus:text-accent-amber focus-visible:ring-accent-amber/30";
    };
    return (
      <div className="flex items-center justify-center gap-1.5 rounded-none border border-border-primary/40 bg-bg-input/50 p-1 backdrop-blur-sm">
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
              className={`flex-1 rounded-none transition-colors duration-100 outline-none disabled:cursor-not-allowed disabled:opacity-60 ${ui.modeBtnPad} ${ui.modeBtnText} font-black uppercase focus-visible:ring-[3px] focus-visible:ring-offset-0 ${modeColorClass(mode, isActive)}`}
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
  const selectedProductColor = productColorFor(selected, selectedProduct);
  const selectedMaxAmount = maxAmountForNozzle(selectedProduct);
  const selectedVolumeInvalid = selectedDraft?.mode === "volume" && !isValidVolume(selectedDraft.volume);
  const selectedAmountInvalid = selectedDraft?.mode === "amount" && !isValidAmount(selectedDraft.amount, selectedProduct);
  const selectedPositionActive = positionActiveByFp.get(selected.fp_id) ?? true;
  const selectedMeta = getMeta(selected, defaultAuthMode, selectedPositionActive);
  const selectedSetupLocked = selectedMeta.hasActivePreAuth || selectedMeta.isDelivering || selectedMeta.isAuthorizing || selectedMeta.isPaused;
  const selectedColumnIndex = Math.max(0, states.findIndex((s) => s.fp_id === selected.fp_id));
  const selectedColumnRatio = selectedColumnIndex / states.length;
  const selectedColumnWidth = `calc(${100 / states.length}% - ${8 / states.length}rem)`;
  const selectedColumnLeft = `calc(${selectedColumnRatio * 100}% + ${8 - selectedColumnRatio * 8}rem)`;
  const centerCellClass = (fpId: string) =>
    fpId === selected.fp_id
      ? "relative z-10 bg-accent-blue/10 transition-colors duration-200"
      : "border-r border-border-primary/30 bg-bg-secondary/20 transition-all duration-300";
  const centerHeaderClass = (fpId: string) =>
    fpId === selected.fp_id
      ? "relative z-10 bg-accent-blue/12 transition-colors duration-200"
      : "border-r border-border-primary/30 bg-bg-secondary/20 transition-all duration-300";

  const renderPumpTile = (state: FpState) => {
    const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
    const nozzle = selectedNozzle(state);
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
    return (
      <div
        key={state.fp_id}
        className={`relative min-w-0 overflow-hidden rounded-none border text-left transition-colors duration-200 ${
          selectedCard
            ? "z-20 border-accent-blue bg-accent-blue/10 shadow-[inset_0_0_0_2px_rgb(var(--color-accent-blue)/0.32),0_12px_28px_-20px_rgba(0,0,0,0.65)]"
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
        {selectedCard ? <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-1.5 bg-accent-blue" aria-hidden /> : null}
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
          <div className={`flex items-center justify-between border-b border-border-primary/25 ${ui.topCardPad} ${statusSolidClass(meta)}`}>
            <span className={`${ui.topCardText} font-black`}>{pumpNumber(state)}</span>
            <span className="min-w-0 truncate text-base font-black uppercase tracking-wider">{classicStatusLabel(meta, t)}</span>
          </div>
          <div className={`grid grid-cols-2 bg-bg-primary/20 ${ui.topGridGap} ${ui.topCardPad} font-mono tabular-nums`}>
            <div>
              <p className={`${ui.topCardLabel} font-extrabold uppercase tracking-wider text-text-muted`}>{t("classic.currentLiters")}</p>
              <p className={`truncate ${ui.topCardText} font-black text-text-primary`}>{(meta.paused?.stopped_volume ?? state.volume).toFixed(2)}</p>
            </div>
            <div className="text-right">
              <p className={`${ui.topCardLabel} font-extrabold uppercase tracking-wider text-text-muted`}>{t("classic.currentAmount")}</p>
              <p className={`truncate ${ui.topCardText} font-black text-accent-blue`}>{fmtSum.format(meta.paused?.stopped_amount ?? state.amount)}</p>
            </div>
          </div>
        </button>
        <div
          className={`flex items-center justify-between border-t border-border-primary/20 bg-bg-secondary/20 ${ui.topGridGap} ${ui.topCardPad} ${ui.topCardLabel}`}
          style={{ boxShadow: `inset 0 3px 0 ${productColor}` }}
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate font-black text-text-secondary">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-border-primary/40" style={{ backgroundColor: productColor }} />
            <span className="min-w-0 truncate">{nozzle?.product_name ?? state.product_name ?? "--"}</span>
          </span>
          <span className="shrink-0 font-mono font-black text-text-primary">{fmtSum.format(nozzle?.price ?? state.price ?? 0)}</span>
        </div>
        {showPumpTotalizer && pumpTotalizer && (
          <div className={`flex items-center justify-between gap-2 border-t border-border-primary/20 bg-bg-secondary/10 px-3 py-1.5 font-mono tabular-nums ${ui.topCardLabel}`}>
            <span className="flex min-w-0 items-center gap-1 truncate font-extrabold uppercase tracking-wider text-text-muted">
              {t("dispenser.totalizer")}
              {pumpTotalizer.nozzleIndex != null ? ` · ${t("dispenser.nozzle")} ${pumpTotalizer.nozzleIndex}` : ""}
            </span>
            <span className="flex shrink-0 items-baseline gap-2">
              <span className="font-bold text-text-secondary">
                {pumpTotalizer.volume != null ? `${pumpTotalizer.volume.toFixed(2)} L` : "—"}
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
        className="flex flex-col gap-3 origin-top-left absolute top-0 left-0"
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

      <div className="relative overflow-hidden rounded-none border border-border-primary/50 bg-bg-card/40 backdrop-blur-md shadow-inner">
        <div
          className="pointer-events-none absolute bottom-0 top-0 z-20 border-2 border-accent-blue shadow-[inset_0_0_0_1px_rgb(var(--color-accent-blue)/0.18)]"
          style={{ left: selectedColumnLeft, width: selectedColumnWidth }}
          aria-hidden
        />
        <table className="w-full table-fixed border-collapse text-center text-xs">
          <colgroup>
            <col className="w-32" />
          </colgroup>
          <tbody className="divide-y divide-border-primary/30">
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.status")}</th>
              {states.map((state) => {
                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
                return (
                  <td key={state.fp_id} className={`${ui.tdPad} ${centerCellClass(state.fp_id)}`}>
                    <span className={`inline-flex w-full min-w-0 justify-center rounded-none border ${ui.modeBtnPad} text-lg font-black uppercase tracking-wider truncate ${statusSolidClass(meta)}`}>
                      {classicStatusLabel(meta, t)}
                    </span>
                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.fuel")}</th>
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
	                        className={`${ui.inputHeight} w-full rounded-none border ${ui.inputPad} pl-7 ${ui.inputText} font-black transition-all duration-200 outline-none disabled:cursor-not-allowed disabled:opacity-70 ${
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
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.price")}</th>
              {states.map((state) => (
	                  <td key={state.fp_id} className={`${ui.tdPad} font-mono text-2xl font-black ${centerCellClass(state.fp_id)}`}>
	                  <span className="text-accent-blue">{fmtSum.format(selectedNozzle(state)?.price ?? state.price ?? 0)}</span>
	                </td>
	              ))}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.orderLiters")}</th>
	              {states.map((state) => {
	                const draft = drafts[state.fp_id];
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
	                        title={`1-${MAX_VOLUME_LITERS} L`}
	                        placeholder="—"
	                        value={draft?.volume ?? ""}
	                        disabled={setupLocked}
	                        onFocus={(e) => {
	                          onSelectFp(state.fp_id);
	                          setActiveOrderField({ fpId: state.fp_id, field: "volume" });
	                          setDraft(state.fp_id, { mode: "volume" });
	                          selectInputValue(e.currentTarget);
	                        }}
                        onMouseUp={(e) => e.preventDefault()}
                        onChange={(e) => updateVolume(state, e.target.value)}
                        onKeyDown={(e) => handleEditKeyDown(state, e)}
	                        className={`${ui.inputHeight} min-w-0 flex-1 rounded-none border pl-16 pr-4 text-center ${ui.inputText} font-mono font-black tabular-nums transition-all duration-200 outline-none disabled:cursor-not-allowed ${centerOrderFocusClass} ${
	                          setupLocked
	                            ? lockedInputClass
	                            : invalid
	                            ? invalidInputClass
	                            : draft?.mode === "volume"
                              ? "border-accent-emerald/50 bg-accent-emerald/10 text-text-primary focus:ring-accent-emerald/30 focus:border-accent-emerald shadow-inner"
                              : "border-border-primary/40 bg-bg-input text-text-primary focus:ring-accent-blue/30 focus:border-accent-blue"
                        } ${activeOrderField?.fpId === state.fp_id && activeOrderField.field === "volume" ? mirroredOrderInputClass : ""}`}
                      />
	                      <span aria-hidden className={`${ui.inputHeight} -ml-px flex ${tableUnitSlotClass} items-center justify-center border border-border-primary/40 bg-bg-secondary/80 text-[10px] font-black tracking-wide text-text-muted`}>
	                        L
	                      </span>
                    </div>
                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.orderAmount")}</th>
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
	                          setActiveOrderField({ fpId: state.fp_id, field: "amount" });
	                          setDraft(state.fp_id, { mode: "amount" });
	                          selectInputValue(e.currentTarget);
	                        }}
                        onMouseUp={(e) => e.preventDefault()}
                        onChange={(e) => updateAmount(state, e.target.value)}
                        onKeyDown={(e) => handleEditKeyDown(state, e)}
	                        className={`${ui.inputHeight} min-w-0 flex-1 rounded-none border pl-16 pr-4 text-center ${ui.inputText} font-mono font-black tabular-nums transition-all duration-200 outline-none disabled:cursor-not-allowed ${centerOrderFocusClass} ${
	                          setupLocked
	                            ? lockedInputClass
	                            : invalid
	                            ? invalidInputClass
	                            : draft?.mode === "amount"
                              ? "border-accent-emerald/50 bg-accent-emerald/10 text-text-primary focus:ring-accent-emerald/30 focus:border-accent-emerald shadow-inner"
                              : "border-border-primary/40 bg-bg-input text-text-primary focus:ring-accent-blue/30 focus:border-accent-blue"
                        } ${activeOrderField?.fpId === state.fp_id && activeOrderField.field === "amount" ? mirroredOrderInputClass : ""}`}
                      />
	                      <span aria-hidden className={`${ui.inputHeight} -ml-px flex ${tableUnitSlotClass} items-center justify-center border border-border-primary/40 bg-bg-secondary/80 text-[10px] font-black tracking-wide text-text-muted`}>
	                        SO'M
	                      </span>
                    </div>
                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.mode")}</th>
              {states.map((state) => (
                <td key={state.fp_id} className={`${ui.tdPad} ${centerCellClass(state.fp_id)}`} data-table-row="mode" data-fp-id={state.fp_id}>{renderModeButtons(state, true)}</td>
              ))}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.currentLiters")}</th>
              {states.map((state) => {
                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
                const draft = drafts[state.fp_id];
                const isActive = meta.isDelivering || meta.isAuthorizing;
                const displayVol = isActive
                  ? (meta.paused?.stopped_volume ?? state.volume)
                  : (draft?.lastFillVolume ?? state.volume);
                return (
	                  <td key={state.fp_id} className={`${ui.tdPad} font-mono font-black tabular-nums ${ui.topCardText} ${centerCellClass(state.fp_id)}`}>
	                    {displayVol.toFixed(2)}
	                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.currentAmount")}</th>
              {states.map((state) => {
                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
                const draft = drafts[state.fp_id];
                const isActive = meta.isDelivering || meta.isAuthorizing;
                const displayAmt = isActive
                  ? (meta.paused?.stopped_amount ?? state.amount)
                  : (draft?.lastFillAmount ?? state.amount);
                return (
	                  <td key={state.fp_id} className={`${ui.tdPad} font-mono font-black tabular-nums ${ui.topCardText} text-accent-blue ${centerCellClass(state.fp_id)}`}>
	                    {fmtSum.format(displayAmt)}
	                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.remaining")}</th>
              {states.map((state) => {
                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
                const draft = drafts[state.fp_id];
                const isActive = meta.isDelivering || meta.isAuthorizing;
                let cell = <span className="text-text-muted/50">—</span>;
                if (isActive) {
                  const volTarget = parseVolumeTarget(state.pre_auth_preset);
                  const amtTarget = parseAmountTarget(state.pre_auth_preset);
                  if (volTarget != null) {
                    const rem = Math.max(0, volTarget - state.volume);
                    cell = <span className="text-accent-amber">{rem.toFixed(2)} L</span>;
                  } else if (amtTarget != null) {
                    const rem = Math.max(0, amtTarget - state.amount);
                    cell = <span className="text-accent-amber">{fmtSum.format(rem)}</span>;
                  }
                } else if (draft?.lastFillPreset != null) {
                  const volTarget = parseVolumeTarget(draft.lastFillPreset);
                  const amtTarget = parseAmountTarget(draft.lastFillPreset);
                  if (volTarget != null && draft.lastFillVolume != null) {
                    const rem = Math.max(0, volTarget - draft.lastFillVolume);
                    cell = <span className="text-text-muted/70">{rem.toFixed(2)} L</span>;
                  } else if (amtTarget != null && draft.lastFillAmount != null) {
                    const rem = Math.max(0, amtTarget - draft.lastFillAmount);
                    cell = <span className="text-text-muted/70">{fmtSum.format(rem)}</span>;
                  }
                }
                return (
	                  <td key={state.fp_id} className={`${ui.tdPad} font-mono font-black tabular-nums ${ui.topCardText} ${centerCellClass(state.fp_id)}`}>
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
        className="shrink-0 overflow-hidden rounded-none border border-border-primary/50 bg-bg-card/80 backdrop-blur-xl shadow-[0_8px_32px_-12px_rgba(0,0,0,0.3)] transition-all duration-300"
      >
        <div className={`flex flex-col border-b border-border-primary/30 ${ui.topCardPad} ${statusTintClass(selectedMeta)} bg-opacity-40`}>
          <div className="flex flex-wrap items-center justify-between">
            <div className="min-w-0">
              <p className={`truncate ${ui.inputText} font-black uppercase tracking-wider text-text-primary`}>
                {t("classic.selectedPump")}: <span className="text-accent-blue">{pumpTitle(selected)}</span>
              </p>
              <p className="flex items-center gap-2 text-lg font-black uppercase tracking-wide opacity-90">
                <span>{t("classic.liveStatus")}: {classicStatusLabel(selectedMeta, t)}</span>
                <span className="h-1 w-1 rounded-full bg-current opacity-50" aria-hidden />
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full border border-border-primary/40" style={{ backgroundColor: selectedProductColor }} />
                  <span className="truncate">{selectedProduct?.product_name ?? selected.product_name ?? "--"}</span>
                </span>
              </p>
            </div>
            <div className="flex gap-8 text-right font-mono tabular-nums">
              <div>
                <p className={`${ui.thText} font-extrabold uppercase tracking-wider opacity-70`}>{t("classic.currentLiters")}</p>
                <p className="font-mono text-3xl font-black tabular-nums">{(selectedMeta.paused?.stopped_volume ?? selected.volume).toFixed(2)}</p>
              </div>
              <div>
                <p className={`${ui.thText} font-extrabold uppercase tracking-wider opacity-70`}>{t("classic.currentAmount")}</p>
                <p className="font-mono text-3xl font-black tabular-nums text-accent-blue">{fmtSum.format(selectedMeta.paused?.stopped_amount ?? selected.amount)}</p>
              </div>
            </div>
          </div>
          {/* Always-present progress track — fixed height so the panel never shifts */}
          {(() => {
            const delivering = selectedMeta.isDelivering || selectedMeta.isAuthorizing;
            const vt = delivering ? parseVolumeTarget(selected.pre_auth_preset) : null;
            const at = delivering ? parseAmountTarget(selected.pre_auth_preset) : null;
            const pct = vt != null && vt > 0
              ? Math.min(100, (selected.volume / vt) * 100)
              : at != null && at > 0
                ? Math.min(100, (selected.amount / at) * 100)
                : 0;
            return (
              <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-bg-secondary/40">
                <div
                  className="h-full rounded-full bg-accent-amber transition-all duration-500"
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
	              className={`flex-1 min-h-0 w-full flex gap-1 rounded-none border border-border-primary/40 p-1 outline-none backdrop-blur-sm transition-all duration-200 ${
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
	                      className={`flex-1 flex flex-col justify-center items-center min-h-0 min-w-0 rounded-none transition-all duration-300 outline-none disabled:cursor-not-allowed ${
	                        isActive
	                          ? "border text-white shadow-[0_4px_12px_rgb(0_0_0/0.22)]"
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
                      <span className="w-full truncate px-1 text-center font-mono text-sm font-bold opacity-90">
                        {fmtSum.format(n.price)}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
          <div className={bottomControlWrapClass}>
            <label className={bottomLabelClass}>{t("classic.orderLiters")}</label>
            <div className="flex-1 min-h-0">
              <input
                data-classic-control="volume"
                type="text"
                inputMode="decimal"
                aria-invalid={selectedVolumeInvalid}
	                title={`1-${MAX_VOLUME_LITERS} L`}
	                placeholder="—"
	                value={selectedDraft?.volume ?? ""}
	                disabled={selectedSetupLocked}
	                onChange={(e) => updateVolume(selected, e.target.value)}
                onFocus={(e) => {
                  setActiveOrderField({ fpId: selected.fp_id, field: "volume" });
                  setDraft(selected.fp_id, { mode: "volume" });
                  selectInputValue(e.currentTarget);
                }}
                onMouseUp={(e) => e.preventDefault()}
                onKeyDown={(e) => handleEditKeyDown(selected, e)}
	                className={`h-full min-h-0 w-full rounded-none border ${ui.inputPad} text-center font-mono text-3xl font-black outline-none backdrop-blur-sm disabled:cursor-not-allowed ${
	                  selectedSetupLocked
	                    ? lockedInputClass
	                    : selectedVolumeInvalid
	                    ? invalidInputClass
	                    : `border-border-primary/40 bg-bg-input/60 text-text-primary ${focusControlClass}`
	                } ${activeOrderField?.fpId === selected.fp_id && activeOrderField.field === "volume" ? mirroredOrderInputClass : ""}`}
              />
            </div>
            <span className={`text-[10px] font-bold ${selectedVolumeInvalid ? "text-accent-red" : "text-text-muted"}`}>
              1-{MAX_VOLUME_LITERS} L
            </span>
          </div>
          <div className={bottomControlWrapClass}>
            <label className={bottomLabelClass}>{t("classic.orderAmount")}</label>
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
                  setActiveOrderField({ fpId: selected.fp_id, field: "amount" });
                  setDraft(selected.fp_id, { mode: "amount" });
                  selectInputValue(e.currentTarget);
                }}
                onMouseUp={(e) => e.preventDefault()}
                onKeyDown={(e) => handleEditKeyDown(selected, e)}
	                className={`h-full min-h-0 w-full rounded-none border ${ui.inputPad} text-center font-mono text-3xl font-black outline-none backdrop-blur-sm disabled:cursor-not-allowed ${
	                  selectedSetupLocked
	                    ? lockedInputClass
	                    : selectedAmountInvalid
	                    ? invalidInputClass
	                    : `border-border-primary/40 bg-bg-input/60 text-text-primary ${focusControlClass}`
	                } ${activeOrderField?.fpId === selected.fp_id && activeOrderField.field === "amount" ? mirroredOrderInputClass : ""}`}
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
