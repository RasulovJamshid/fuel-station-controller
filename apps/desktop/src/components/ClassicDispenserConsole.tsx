import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { pausedInfo, statusTag } from "../types/api";
import type { AuthMode, FpState, FpStatus, NozzleSnapshot } from "../types/api";
import type { AuthorizeRequest, FillMode } from "./DispenserCard";

const fmtSum = new Intl.NumberFormat("uz-UZ");

function parseNum(s: string): number {
  const v = Number.parseFloat(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(v) ? v : 0;
}

function pumpTitle(state: FpState): string {
  return state.label?.trim() ||
    (state.fp_id.match(/\d+/)?.[0] ? `${state.fp_id.match(/\d+/)![0]}-KOLONKA` : state.fp_id);
}

function pumpNumber(state: FpState): string {
  return state.fp_id.match(/\d+/)?.[0] ?? state.fp_id.slice(0, 2).toUpperCase();
}

type PumpDraft = {
  nozzleIndex: number | null;
  mode: FillMode;
  volume: string;
  amount: string;
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

function statusClass(meta: PumpMeta): string {
  if (meta.isOffline) return "border-accent-red/40 bg-accent-red/10 text-accent-red shadow-[inset_0_0_20px_rgba(var(--color-accent-red),0.05)]";
  if (meta.isDelivering || meta.isAuthorizing) return "border-accent-emerald/40 bg-accent-emerald/10 text-accent-emerald shadow-[inset_0_0_20px_rgba(var(--color-accent-emerald),0.05)]";
  if (meta.hasActivePreAuth || meta.isPaused) return "border-accent-amber/40 bg-accent-amber/10 text-accent-amber shadow-[inset_0_0_20px_rgba(var(--color-accent-amber),0.05)]";
  if (meta.isNozzleUp) return "border-accent-blue/40 bg-accent-blue/10 text-accent-blue shadow-[inset_0_0_20px_rgba(var(--color-accent-blue),0.05)]";
  return "border-border-primary/50 bg-bg-secondary/40 text-text-secondary backdrop-blur-sm";
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
  const [drafts, setDrafts] = useState<Record<string, PumpDraft>>({});
  const consoleRef = useRef<HTMLDivElement>(null);
  const pumpButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const bottomPanelRef = useRef<HTMLDivElement>(null);

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
    topCardText: "text-lg",
    topCardLabel: "text-xs",
    
    thPad: "px-4 py-3",
    tdPad: "px-3 py-2",
    thText: "text-xs",
    
    inputHeight: "h-11",
    inputText: "text-xl",
    inputPad: "px-4",
    
    modeBtnPad: "px-3 py-2",
    modeBtnText: "text-sm",
    
    btnHeight: "h-10",
    btnPad: "px-4",
    btnText: "text-sm",
  };

  const focusControlClass =
    "transition-all duration-200 focus:border-accent-blue focus:bg-bg-primary focus:ring-[4px] focus:ring-accent-blue/30 focus:ring-offset-0 focus:outline-none shadow-sm focus:shadow-md";
  const bottomControlWrapClass =
    "group flex flex-col gap-1 rounded-xl border border-border-primary/50 bg-bg-secondary/20 p-3 transition-all duration-300 hover:bg-bg-secondary/40 hover:shadow-md focus-within:-translate-y-1 focus-within:border-accent-blue focus-within:bg-accent-blue/5 focus-within:shadow-[0_8px_24px_-8px_rgba(var(--color-accent-blue),0.4)]";
  const bottomLabelClass =
    "mb-1.5 block text-[10px] font-extrabold uppercase tracking-wider text-text-muted transition-colors duration-200 group-focus-within:text-accent-blue group-hover:text-text-secondary";

  useEffect(() => {
    setDrafts((prev) => {
      const next: Record<string, PumpDraft> = {};
      for (const state of states) {
        const nozzles = (nozzlesByFp.get(state.fp_id) ?? []).filter((n) => n.active);
        const prevDraft = prev[state.fp_id];
        const prevNozzleValid =
          prevDraft?.nozzleIndex != null && nozzles.some((n) => n.index === prevDraft.nozzleIndex);
        const stateNozzleValid =
          state.nozzle_index != null && nozzles.some((n) => n.index === state.nozzle_index);
        const tag = statusTag(state.status as FpStatus);
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
        const price = nozzles.find((n) => n.index === nozzleIndex)?.price ?? 0;
        next[state.fp_id] = {
          nozzleIndex,
          mode: prevDraft?.mode ?? "volume",
          volume: prevDraft?.volume ?? "10",
          amount: prevDraft?.amount ?? (price > 0 ? String(price * 10) : "150000"),
        };
      }
      return next;
    });
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
        volume: "10",
        amount: "150000",
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

  const buildRequest = useCallback((state: FpState): AuthorizeRequest | null => {
    const draft = drafts[state.fp_id];
    const nozzle = selectedNozzle(state);
    if (!draft || !nozzle) return null;
    let limitValue: number | null = null;
    if (draft.mode === "volume") {
      const v = parseNum(draft.volume);
      if (v <= 0) return null;
      limitValue = v;
    } else if (draft.mode === "amount") {
      const a = parseNum(draft.amount);
      if (a <= 0) return null;
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
      if (focusTarget instanceof HTMLInputElement) focusTarget.select();
    });
  }, []);

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

  const focusTableControlByOffset = useCallback((currentName: string, fpId: string, offset: number) => {
    const root = consoleRef.current;
    if (!root) return;
    const rows = ["fuel", "volume", "amount", "mode"];
    const currentIndex = rows.indexOf(currentName);
    if (currentIndex < 0) return;
    const targetRow = rows[(currentIndex + offset + rows.length) % rows.length];
    
    const container = root.querySelector<HTMLElement>(`[data-table-row='${targetRow}'][data-fp-id='${fpId}']`);
    if (!container) return;
    const focusTarget = container.matches("button,input,select") ? container : container.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])");
    focusTarget?.focus();
    if (focusTarget instanceof HTMLInputElement) focusTarget.select();
  }, []);

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
        if (focusTarget instanceof HTMLInputElement) focusTarget.select();
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
      focusBottomControlByOffset(null, 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      focusBottomControlByOffset(null, -1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      startPump(state);
    }
  }, [focusBottomControlByOffset, selectPumpByOffset, startPump]);

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
      if (!tableRowName) focusBottomControlByOffset(currentControl, 1);
      else selectPumpByOffset(state.fp_id, 1, currentControl, tableRowName);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (!tableRowName) focusBottomControlByOffset(currentControl, -1);
      else selectPumpByOffset(state.fp_id, -1, currentControl, tableRowName);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (tableRowName) focusTableControlByOffset(tableRowName, state.fp_id, 1);
      else selectPumpByOffset(state.fp_id, 1, currentControl);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (tableRowName) focusTableControlByOffset(tableRowName, state.fp_id, -1);
      else selectPumpByOffset(state.fp_id, -1, currentControl);
    }
  }, [focusBottomControlByOffset, focusPump, focusTableControlByOffset, selectPumpByOffset, startPump]);

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
      selectPumpByOffset(state.fp_id, 1, currentControl);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectPumpByOffset(state.fp_id, -1, currentControl);
    }
  }, [focusBottomControlByOffset, focusPump, selectPumpByOffset]);

  const handleConsoleKeyDownCapture = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const selectedState = activeState ?? states[0];
    if (!selectedState) return;

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
      if (tableRowName) focusTableControlByOffset(tableRowName, selectedState.fp_id, 1);
      else focusBottomControlByOffset(currentControl, 1);
      return;
    }
    if (tableRowName) focusTableControlByOffset(tableRowName, selectedState.fp_id, -1);
    else focusBottomControlByOffset(currentControl, -1);
  }, [activeState, focusBottomControlByOffset, focusTableControlByOffset, selectPumpByOffset, states]);

  const updateVolume = useCallback((state: FpState, raw: string) => {
    const nozzle = selectedNozzle(state);
    const liters = parseNum(raw);
    setDraft(state.fp_id, {
      mode: "volume",
      volume: raw,
      amount: nozzle?.price && liters > 0 ? String(Math.round(liters * nozzle.price)) : drafts[state.fp_id]?.amount,
    });
  }, [drafts, selectedNozzle, setDraft]);

  const updateAmount = useCallback((state: FpState, raw: string) => {
    const nozzle = selectedNozzle(state);
    const amount = parseNum(raw);
    setDraft(state.fp_id, {
      mode: "amount",
      amount: raw,
      volume: nozzle?.price && amount > 0 ? String(Math.round((amount / nozzle.price) * 10) / 10) : drafts[state.fp_id]?.volume,
    });
  }, [drafts, selectedNozzle, setDraft]);

  const renderAction = (state: FpState, compact = false) => {
    const positionActive = positionActiveByFp.get(state.fp_id) ?? true;
    const meta = getMeta(state, defaultAuthMode, positionActive);
    const paused = meta.paused;
    const baseClass = `${ui.btnHeight} ${ui.btnPad} ${ui.btnText} rounded-md`;
    const cls = `${baseClass} w-full flex-1 font-black uppercase tracking-wider outline-none transition-colors duration-200 active:brightness-95 focus-visible:ring-[3px] focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none`;

    if (meta.canAuthorize) {
      return (
        <button
          type="button"
          disabled={!shiftRequired && !buildRequest(state)}
          onClick={() => startPump(state)}
          className={`${cls} border border-accent-emerald/80 bg-accent-emerald text-text-inverse hover:bg-accent-emerald-light shadow-[0_4px_12px_rgba(var(--color-accent-emerald),0.2)] focus-visible:ring-accent-emerald/30`}
        >
          {shiftRequired ? t("classic.startShift") : t("classic.start")}
        </button>
      );
    }
    if (meta.isDelivering) {
      return (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => onStop(state.fp_id)}
            className={`${cls} border border-accent-amber/80 bg-accent-amber text-text-inverse hover:bg-accent-amber-light shadow-[0_4px_12px_rgba(var(--color-accent-amber),0.2)] focus-visible:ring-accent-amber/30`}
          >
            {useStopMode ? t("classic.stop") : t("classic.pause")}
          </button>
          {useCancelMode && onCancel ? (
            <button
              type="button"
              onClick={() => onCancel(state.fp_id)}
              className={`${cls} border border-accent-red/80 bg-accent-red text-text-inverse hover:bg-accent-red-light shadow-[0_4px_12px_rgba(var(--color-accent-red),0.2)] focus-visible:ring-accent-red/30`}
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
              className={`${cls} border border-accent-emerald/80 bg-accent-emerald text-text-inverse hover:bg-accent-emerald-light shadow-[0_4px_12px_rgba(var(--color-accent-emerald),0.2)] focus-visible:ring-accent-emerald/30`}
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
            className={`${cls} border border-accent-emerald/80 bg-accent-emerald text-text-inverse hover:bg-accent-emerald-light shadow-[0_4px_12px_rgba(var(--color-accent-emerald),0.2)] focus-visible:ring-accent-emerald/30`}
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
    return <span className="block text-center text-[11px] font-bold tracking-wider text-text-muted/60 uppercase">--</span>;
  };

  const renderModeButtons = (state: FpState, compact = false, keyboardControls = false) => {
    const draft = drafts[state.fp_id];
    const modes: FillMode[] = ["full", "volume", "amount"];
    return (
      <div className="flex items-center justify-center gap-1.5 rounded-lg border border-border-primary/40 bg-bg-input/50 p-1 backdrop-blur-sm">
        {modes.map((mode) => (
          <button
            key={mode}
            type="button"
            data-classic-control={keyboardControls ? `mode-${mode}` : undefined}
            onClick={() => setDraft(state.fp_id, { mode })}
            onKeyDown={keyboardControls ? (e) => handleControlNavKeyDown(state, e) : undefined}
              className={`flex-1 rounded transition-all duration-200 outline-none ${ui.modeBtnPad} ${ui.modeBtnText} font-black uppercase ${focusControlClass} ${
              draft?.mode === mode
                ? "bg-accent-blue text-text-inverse shadow-[0_2px_8px_rgba(var(--color-accent-blue),0.3)] scale-100"
                : "text-text-muted hover:bg-bg-secondary hover:text-text-primary scale-95 hover:scale-100"
            }`}
          >
            {mode === "full"
              ? t("classic.full")
              : mode === "volume"
                ? t("classic.volume")
                : t("classic.amount")}
          </button>
        ))}
      </div>
    );
  };

  if (states.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-border-primary bg-bg-card text-sm font-semibold text-text-muted">
        {t("classic.noDispensers")}
      </div>
    );
  }

  const selected = activeState ?? states[0]!;
  const selectedNozzles = (nozzlesByFp.get(selected.fp_id) ?? []).filter((n) => n.active);
  const selectedDraft = drafts[selected.fp_id];
  const selectedProduct = selectedNozzle(selected);
  const selectedPositionActive = positionActiveByFp.get(selected.fp_id) ?? true;
  const selectedMeta = getMeta(selected, defaultAuthMode, selectedPositionActive);
  const centerCellClass = (fpId: string) =>
    fpId === selected.fp_id
      ? "border-x border-accent-blue/45 bg-accent-blue/10 shadow-[inset_0_0_0_1px_rgb(var(--color-accent-blue)/0.14)] transition-colors duration-300"
      : "border-r border-border-primary/30 transition-colors duration-300";
  const centerHeaderClass = (fpId: string) =>
    fpId === selected.fp_id
      ? "border-x border-accent-blue/55 bg-accent-blue/14 transition-colors duration-300"
      : "border-r border-border-primary/30 transition-colors duration-300";

  const renderPumpTile = (state: FpState) => {
    const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
    const nozzle = selectedNozzle(state);
    const selectedCard = state.fp_id === selected.fp_id;
    return (
      <div
        key={state.fp_id}
        className={`min-w-0 overflow-hidden rounded-xl border bg-bg-card/80 text-left shadow-card backdrop-blur-sm transition-all duration-200 ${
          selectedCard
            ? "border-accent-blue ring-2 ring-accent-blue/20 shadow-card-hover"
            : "border-border-primary/60 hover:border-accent-blue/40"
        }`}
      >
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
          <div className={`flex items-center justify-between border-b border-border-primary/25 ${ui.topCardPad} ${statusClass(meta)}`}>
            <span className={`${ui.topCardText} font-black`}>{pumpNumber(state)}</span>
            <span className={`truncate ${ui.topCardLabel} font-black uppercase tracking-wider`}>{classicStatusLabel(meta, t)}</span>
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
        <div className={`flex items-center justify-between border-t border-border-primary/20 bg-bg-secondary/20 ${ui.topGridGap} ${ui.topCardPad} ${ui.topCardLabel}`}>
          <span className="min-w-0 truncate font-bold text-text-secondary">{nozzle?.product_name ?? state.product_name ?? "--"}</span>
          <span className="shrink-0 font-mono font-bold text-text-primary">{fmtSum.format(nozzle?.price ?? state.price ?? 0)}</span>
        </div>
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
      className="classic-console relative h-full min-h-0 w-full overflow-hidden rounded-2xl bg-bg-primary text-text-primary"
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
        style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(states.length, 1), 8)}, minmax(0, 1fr))` }}
      >
        {states.map(renderPumpTile)}
      </div>

      <div className="rounded-xl border border-border-primary/50 bg-bg-card/40 backdrop-blur-md shadow-inner">
        <table className="w-full table-fixed border-collapse text-center text-xs">
          <thead>
            <tr className={`bg-bg-secondary/60 ${ui.thText} font-black uppercase tracking-wider text-text-secondary backdrop-blur-sm`}>
              <th className={`sticky left-0 z-20 w-32 border-b border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] align-bottom`}>
                <div className="pb-1 text-text-muted font-bold tracking-wider uppercase">{t("classic.field")}</div>
              </th>
              {states.map((state) => (
                  <th key={state.fp_id} className={`border-b border-border-primary/40 ${ui.thPad} align-bottom ${centerHeaderClass(state.fp_id)}`}>
                    <button
                      type="button"
                      onClick={() => onSelectFp(state.fp_id)}
                      onKeyDown={(e) => handlePumpKeyDown(state, e)}
                      className={`w-full rounded ${ui.thPad} ${ui.thText} font-black tracking-wider transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-accent-blue truncate ${
                        state.fp_id === selected.fp_id ? "bg-accent-blue text-text-inverse shadow-[0_4px_12px_rgba(var(--color-accent-blue),0.3)] scale-105" : "bg-bg-card/50 text-text-primary hover:bg-bg-tertiary hover:scale-105"
                      }`}
                    >
                      {pumpTitle(state)}
                    </button>
                  </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-primary/30">
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.status")}</th>
              {states.map((state) => {
                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
                return (
                  <td key={state.fp_id} className={`${ui.tdPad} ${centerCellClass(state.fp_id)}`}>
                    <span className={`inline-flex w-full min-w-0 justify-center rounded border ${ui.modeBtnPad} font-black uppercase tracking-wider ${ui.thText} truncate ${statusClass(meta)}`}>
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
                return (
                  <td key={state.fp_id} className={`${ui.tdPad} ${centerCellClass(state.fp_id)}`} data-table-row="fuel" data-fp-id={state.fp_id}>
                    <select
                      value={draft?.nozzleIndex ?? ""}
                      disabled={nozzles.length <= 1}
                      onFocus={() => onSelectFp(state.fp_id)}
                      onKeyDown={(e) => handleEditKeyDown(state, e)}
                      onChange={(e) => {
                        const nozzleIndex = e.target.value ? Number(e.target.value) : null;
                        const nozzle = nozzles.find((n) => n.index === nozzleIndex);
                        const volume = drafts[state.fp_id]?.volume ?? "10";
                        setDraft(state.fp_id, {
                          nozzleIndex,
                          amount: nozzle?.price && parseNum(volume) > 0
                            ? String(Math.round(parseNum(volume) * nozzle.price))
                            : drafts[state.fp_id]?.amount,
                        });
                      }}
                      className={`${ui.inputHeight} w-full rounded border border-border-primary/40 bg-bg-input ${ui.inputPad} ${ui.inputText} font-bold text-text-primary transition-all duration-200 outline-none focus:border-accent-blue focus:ring-2 focus:ring-accent-blue/30 focus:ring-offset-0 disabled:opacity-60`}
                    >
                      {nozzles.length > 1 ? <option value="">--</option> : null}
                      {nozzles.map((n) => (
                        <option key={n.index} value={n.index}>{n.product_name}</option>
                      ))}
                    </select>
                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.price")}</th>
              {states.map((state) => (
                <td key={state.fp_id} className={`${ui.tdPad} font-mono font-bold ${ui.inputText} ${centerCellClass(state.fp_id)}`}>
                  <span className="text-accent-blue">{fmtSum.format(selectedNozzle(state)?.price ?? state.price ?? 0)}</span>
                </td>
              ))}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.orderLiters")}</th>
              {states.map((state) => (
                <td key={state.fp_id} className={`${ui.tdPad} ${centerCellClass(state.fp_id)}`} data-table-row="volume" data-fp-id={state.fp_id}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={drafts[state.fp_id]?.volume ?? ""}
                    onFocus={(e) => { onSelectFp(state.fp_id); e.currentTarget.select(); }}
                    onChange={(e) => updateVolume(state, e.target.value)}
                    onKeyDown={(e) => handleEditKeyDown(state, e)}
                    className={`${ui.inputHeight} w-full rounded border ${ui.inputPad} text-center ${ui.inputText} font-mono font-black tabular-nums transition-all duration-200 outline-none focus:ring-2 focus:ring-offset-0 ${
                      drafts[state.fp_id]?.mode === "volume"
                        ? "border-accent-emerald/50 bg-accent-emerald/10 text-text-primary focus:ring-accent-emerald/30 focus:border-accent-emerald shadow-inner"
                        : "border-border-primary/40 bg-bg-input text-text-primary focus:ring-accent-blue/30 focus:border-accent-blue"
                    }`}
                  />
                </td>
              ))}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.orderAmount")}</th>
              {states.map((state) => (
                <td key={state.fp_id} className={`${ui.tdPad} ${centerCellClass(state.fp_id)}`} data-table-row="amount" data-fp-id={state.fp_id}>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={drafts[state.fp_id]?.amount ?? ""}
                    onFocus={(e) => { onSelectFp(state.fp_id); e.currentTarget.select(); }}
                    onChange={(e) => updateAmount(state, e.target.value)}
                    onKeyDown={(e) => handleEditKeyDown(state, e)}
                    className={`${ui.inputHeight} w-full rounded border ${ui.inputPad} text-center ${ui.inputText} font-mono font-black tabular-nums transition-all duration-200 outline-none focus:ring-2 focus:ring-offset-0 ${
                      drafts[state.fp_id]?.mode === "amount"
                        ? "border-accent-emerald/50 bg-accent-emerald/10 text-text-primary focus:ring-accent-emerald/30 focus:border-accent-emerald shadow-inner"
                        : "border-border-primary/40 bg-bg-input text-text-primary focus:ring-accent-blue/30 focus:border-accent-blue"
                    }`}
                  />
                </td>
              ))}
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
                return (
                  <td key={state.fp_id} className={`${ui.tdPad} font-mono font-black tabular-nums ${ui.topCardText} ${centerCellClass(state.fp_id)}`}>
                    {(meta.paused?.stopped_volume ?? state.volume).toFixed(2)}
                  </td>
                );
              })}
            </tr>
            <tr className="hover:bg-bg-primary/20 transition-colors">
              <th className={`sticky left-0 z-10 border-r border-border-primary/40 bg-bg-secondary/90 ${ui.thPad} text-left shadow-[4px_0_12px_rgba(0,0,0,0.05)] ${ui.thText} uppercase font-bold tracking-wider`}>{t("classic.currentAmount")}</th>
              {states.map((state) => {
                const meta = getMeta(state, defaultAuthMode, positionActiveByFp.get(state.fp_id) ?? true);
                return (
                  <td key={state.fp_id} className={`${ui.tdPad} font-mono font-black tabular-nums ${ui.topCardText} text-accent-blue ${centerCellClass(state.fp_id)}`}>
                    {fmtSum.format(meta.paused?.stopped_amount ?? state.amount)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <div
        ref={bottomPanelRef}
        className="shrink-0 overflow-hidden rounded-2xl border border-border-primary/50 bg-bg-card/80 backdrop-blur-xl shadow-[0_8px_32px_-12px_rgba(0,0,0,0.3)] transition-all duration-300"
      >
        <div className={`flex flex-wrap items-center justify-between border-b border-border-primary/30 ${ui.topCardPad} ${statusClass(selectedMeta)} bg-opacity-40`}>
          <div className="min-w-0">
            <p className={`truncate ${ui.inputText} font-black uppercase tracking-wider text-text-primary`}>
              {t("classic.selectedPump")}: <span className="text-accent-blue">{pumpTitle(selected)}</span>
            </p>
            <p className="text-sm font-extrabold uppercase tracking-wide opacity-90">
              {t("classic.liveStatus")}: {selectedMeta.tag}
            </p>
          </div>
          <div className="flex gap-8 text-right font-mono tabular-nums">
            <div>
              <p className={`${ui.thText} font-extrabold uppercase tracking-wider opacity-70`}>{t("classic.currentLiters")}</p>
              <p className={`${ui.inputText} font-black`}>{(selectedMeta.paused?.stopped_volume ?? selected.volume).toFixed(2)}</p>
            </div>
            <div>
              <p className={`${ui.thText} font-extrabold uppercase tracking-wider opacity-70`}>{t("classic.currentAmount")}</p>
              <p className={`${ui.inputText} font-black text-accent-blue`}>{fmtSum.format(selectedMeta.paused?.stopped_amount ?? selected.amount)}</p>
            </div>
          </div>
        </div>
        <div className={`grid ${ui.topGridGap} ${ui.topCardPad} lg:grid-cols-[1.1fr_1fr_1fr_auto]`}>
          <div className={`min-w-0 ${bottomControlWrapClass}`}>
            <label className={bottomLabelClass}>{t("classic.fuel")}</label>
            <div
              data-classic-control="fuel"
              tabIndex={selectedNozzles.length > 0 ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
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
              className={`flex-1 min-h-0 w-full flex gap-1 rounded border border-border-primary/40 bg-bg-input/60 p-1 outline-none backdrop-blur-sm transition-all duration-200 ${focusControlClass} ${selectedNozzles.length <= 1 ? "opacity-80" : "cursor-pointer"}`}
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
                      onClick={(e) => {
                        e.stopPropagation();
                        setDraft(selected.fp_id, { nozzleIndex: n.index });
                        e.currentTarget.parentElement?.focus();
                      }}
                      className={`flex-1 flex flex-col justify-center items-center min-h-0 min-w-0 rounded transition-all duration-300 outline-none ${
                        isActive
                          ? "bg-accent-blue border border-accent-blue/50 text-text-inverse shadow-[0_4px_12px_rgba(var(--color-accent-blue),0.4)]"
                          : "bg-transparent text-text-primary hover:bg-bg-secondary"
                      }`}
                    >
                      <span className={`font-black uppercase tracking-wider truncate px-1 w-full text-center ${ui.inputText}`}>
                        {n.product_name}
                      </span>
                      <span className="text-[10px] font-mono opacity-80 truncate px-1 w-full text-center">
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
            <input
              data-classic-control="volume"
              type="text"
              inputMode="decimal"
              value={selectedDraft?.volume ?? ""}
              onChange={(e) => updateVolume(selected, e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => handleEditKeyDown(selected, e)}
              className={`flex-1 min-h-0 w-full rounded border border-border-primary/40 bg-bg-input/60 ${ui.inputPad} text-center font-mono ${ui.inputText} font-black text-text-primary outline-none backdrop-blur-sm ${focusControlClass}`}
            />
          </div>
          <div className={bottomControlWrapClass}>
            <label className={bottomLabelClass}>{t("classic.orderAmount")}</label>
            <input
              data-classic-control="amount"
              type="text"
              inputMode="numeric"
              value={selectedDraft?.amount ?? ""}
              onChange={(e) => updateAmount(selected, e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => handleEditKeyDown(selected, e)}
              className={`flex-1 min-h-0 w-full rounded border border-border-primary/40 bg-bg-input/60 ${ui.inputPad} text-center font-mono ${ui.inputText} font-black text-text-primary outline-none backdrop-blur-sm ${focusControlClass}`}
            />
          </div>
          <div className={`${bottomControlWrapClass} flex min-w-64 flex-col justify-end gap-3`}>
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
