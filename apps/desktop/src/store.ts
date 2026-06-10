import { create } from "zustand";
import {
  buildPreAuthNozzleMismatch,
  type PreAuthNozzleMismatchInfo,
} from "./preAuthNozzleMismatch";
import {
  DONE_DISPLAY_HOLD_MS,
  mergeIncomingFpState,
  mergeIncomingFpStates,
} from "./fpStateMerge";
import type { AuthMode, FpState, Shift, ShiftMode, SiteSnapshot, WsEvent } from "./types/api";

function normalizeAuthMode(raw: string | undefined): AuthMode {
  const m = (raw ?? "reactive").toLowerCase();
  if (m === "preauth" || m === "reactive") return m;
  return "reactive";
}

function normalizeShiftMode(raw: string | undefined): ShiftMode {
  const m = (raw ?? "manual").toLowerCase();
  if (m === "disabled" || m === "manual" || m === "scheduled") return m;
  return "manual";
}

interface AppState {
  siteName: string;
  connection: string;
  wsConnected: boolean;
  states: FpState[];
  invokeError: string | null;
  setSite: (name: string) => void;
  setConnection: (label: string) => void;
  setWsConnected: (v: boolean) => void;
  setStates: (rows: FpState[]) => void;
  setInvokeError: (msg: string | null) => void;
  siteSnapshot: SiteSnapshot | null;
  simOnline: boolean;
  setSiteSnapshot: (s: SiteSnapshot | null) => void;
  setSimOnline: (v: boolean) => void;
  applyWsEvent: (ev: WsEvent) => void;
  currentShift: Shift | null;
  shiftWarningMinutes: number | null;
  /** fp_id → timestamp (ms) when nozzle-removed banner was shown */
  nozzleRemovedAt: Record<string, number>;
  /** fp_id → keep DONE totals on screen until this time (ms) */
  holdDoneUntil: Record<string, number>;
  /** fp_id → how the last sale on this pump ended (for DONE banner copy) */
  lastSaleOutcome: Record<string, "completed" | "holster_ended" | "aborted">;
  /** fp_id → totals of the most recently completed sale (shown on idle card) */
  lastSale: Record<string, { volume: number; amount: number }>;
  preAuthTimeoutFpId: string | null;
  preAuthNozzleMismatch: PreAuthNozzleMismatchInfo | null;
  setPreAuthNozzleMismatch: (info: PreAuthNozzleMismatchInfo | null) => void;
  setCurrentShift: (shift: Shift | null) => void;
  setShiftWarningMinutes: (minutes: number | null) => void;
  clearNozzleRemovedNotice: (fpId: string) => void;
  clearPreAuthTimeoutNotice: () => void;
  clearPreAuthNozzleMismatch: () => void;
  /** After operator dismisses a completed-sale screen, return pump card to idle. */
  clearSaleDisplay: (fpId: string) => void;
  /**
   * Called when the service (re)connects. Wipes all transient per-pump UI state
   * so the fresh status snapshot from the server is accepted without stale guards
   * (holdDoneUntil, lastSaleOutcome, etc.) suppressing the update.
   */
  resetServiceState: () => void;
  /** Compact UI mode for smaller / touch screens. Persisted to localStorage. */
  smallScreen: boolean;
  setSmallScreen: (v: boolean) => void;
  /** Light/dark theme. Persisted to localStorage; applies html.light class. */
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  siteName: "AZS",
  connection: "…",
  wsConnected: false,
  states: [],
  invokeError: null,
  siteSnapshot: null,
  simOnline: false,
  currentShift: null,
  shiftWarningMinutes: null,
  nozzleRemovedAt: {},
  holdDoneUntil: {},
  lastSaleOutcome: {},
  lastSale: {},
  preAuthTimeoutFpId: null,
  preAuthNozzleMismatch: null,
  smallScreen: (() => {
    try { return localStorage.getItem("azs_small_screen") === "1"; } catch { return false; }
  })(),
  setSmallScreen: (v) => {
    try { localStorage.setItem("azs_small_screen", v ? "1" : "0"); } catch { /* ignore */ }
    set({ smallScreen: v });
  },
  theme: (() => {
    try { return localStorage.getItem("azs_theme") === "light" ? "light" : "dark"; } catch { return "dark"; }
  })() as "dark" | "light",
  setTheme: (t) => {
    try { localStorage.setItem("azs_theme", t); } catch { /* ignore */ }
    if (t === "light") {
      document.documentElement.classList.add("light");
    } else {
      document.documentElement.classList.remove("light");
    }
    set({ theme: t });
  },
  setCurrentShift: (currentShift) => set({ currentShift }),
  setShiftWarningMinutes: (shiftWarningMinutes) => set({ shiftWarningMinutes }),
  clearNozzleRemovedNotice: (fpId) =>
    set((s) => {
      const next = { ...s.nozzleRemovedAt };
      delete next[fpId];
      return { nozzleRemovedAt: next };
    }),
  clearPreAuthTimeoutNotice: () => set({ preAuthTimeoutFpId: null }),
  clearPreAuthNozzleMismatch: () => set({ preAuthNozzleMismatch: null }),
  clearSaleDisplay: (fpId) =>
    set((s) => {
      const holdDoneUntil = { ...s.holdDoneUntil };
      delete holdDoneUntil[fpId];
      const lastSaleOutcome = { ...s.lastSaleOutcome };
      delete lastSaleOutcome[fpId];
      const states = s.states.map((row) =>
        row.fp_id === fpId
          ? {
              ...row,
              status: "IDLE" as const,
              volume: 0,
              amount: 0,
              // Clear nozzle/product so the next customer's form starts blank.
              nozzle_index: null,
              product_id: null,
              product_name: null,
              product_color: null,
              pre_auth_preset: null,
              stopped_tx_id: null,
              stop_source: null,
              base_volume: null,
              base_amount: null,
              segment_volume: null,
              segment_amount: null,
            }
          : row,
      );
      return { states, holdDoneUntil, lastSaleOutcome };
    }),
  resetServiceState: () =>
    set({
      holdDoneUntil: {},
      lastSaleOutcome: {},
      nozzleRemovedAt: {},
      preAuthTimeoutFpId: null,
      preAuthNozzleMismatch: null,
      currentShift: null,
      shiftWarningMinutes: null,
    }),
  setPreAuthNozzleMismatch: (preAuthNozzleMismatch) => set({ preAuthNozzleMismatch }),
  setSite: (siteName) => set({ siteName }),
  setConnection: (connection) => set({ connection }),
  setWsConnected: (wsConnected) => set({ wsConnected }),
  setStates: (incomingRows) =>
    set((s) => ({
      states: mergeIncomingFpStates(s.states, incomingRows, s.holdDoneUntil),
    })),
  setInvokeError: (invokeError) => set({ invokeError }),
  setSiteSnapshot: (raw) => {
    if (!raw) {
      set({ siteSnapshot: null });
      return;
    }
    set({
      siteSnapshot: {
        ...raw,
        shift_mode: normalizeShiftMode(raw.shift_mode),
        shift_schedule: raw.shift_schedule ?? [],
        require_operator_pin: raw.require_operator_pin ?? false,
        default_auth_mode: normalizeAuthMode(raw.default_auth_mode),
      },
    });
  },
  setSimOnline: (simOnline) => set({ simOnline }),
  applyWsEvent: (ev) => {
    if (ev.event === "fp.status") {
      const incoming = ev.data;
      const next = [...get().states];
      const i = next.findIndex((s) => s.fp_id === incoming.fp_id);
      if (i >= 0) {
        next[i] = mergeIncomingFpState(next[i], incoming, get().holdDoneUntil);
      } else {
        next.push(incoming);
      }
      const tag =
        typeof incoming.status === "object" && incoming.status !== null && "STOPPED" in incoming.status
          ? "STOPPED"
          : incoming.status;
      const mismatch = get().preAuthNozzleMismatch;
      if (
        mismatch?.fpId === incoming.fp_id &&
        (tag === "AUTHORIZING" || tag === "DELIVERING")
      ) {
        set({ states: next, preAuthNozzleMismatch: null });
        return;
      }
      set({ states: next });
      return;
    }
    if (ev.event === "fp.paused") {
      const d = ev.data;
      const next = [...get().states];
      const i = next.findIndex((s) => s.fp_id === d.fp_id);
      if (i >= 0) {
        next[i] = {
          ...next[i]!,
          status: {
            STOPPED: {
              stopped_volume: d.stopped_volume,
              stopped_amount: d.stopped_amount,
              stopped_tx_id: d.stopped_tx_id,
              stop_source: d.stop_source,
            },
          },
          volume: d.stopped_volume,
          amount: d.stopped_amount,
          stopped_tx_id: d.stopped_tx_id,
          stop_source: d.stop_source,
          base_volume: null,
          base_amount: null,
          segment_volume: null,
          segment_amount: null,
        };
        set({ states: next });
      }
      return;
    }
    if (ev.event === "fp.done") {
      const tx = ev.data;
      const combinedVol = (tx.combined_volume ?? 0) > 0 ? tx.combined_volume! : tx.volume;
      const combinedAmt = (tx.combined_amount ?? 0) > 0 ? tx.combined_amount! : tx.amount;
      const outcome =
        tx.status === "COMPLETED" ||
        (typeof tx.status === "object" && tx.status !== null && "CONTINUED_FROM" in tx.status)
          ? "completed"
          : tx.status === "ABORTED"
            ? "aborted"
            : "holster_ended";
      const next = [...get().states];
      const i = next.findIndex((s) => s.fp_id === tx.fp_id);
      if (i >= 0) {
        next[i] = {
          ...next[i],
          status: "DONE",
          volume: combinedVol,
          amount: combinedAmt,
          price: tx.price,
          nozzle_index: tx.nozzle_index,
          product_id: tx.product_id,
          product_name: tx.product_name,
        };
        set({
          states: next,
          holdDoneUntil: {
            ...get().holdDoneUntil,
            [tx.fp_id]: Date.now() + DONE_DISPLAY_HOLD_MS,
          },
          lastSaleOutcome: { ...get().lastSaleOutcome, [tx.fp_id]: outcome },
          lastSale: { ...get().lastSale, [tx.fp_id]: { volume: combinedVol, amount: combinedAmt } },
        });
      }
      return;
    }
    if (ev.event === "fp.pre_authorized") {
      const d = ev.data;
      const cleared = { ...get().lastSaleOutcome };
      delete cleared[d.fp_id];
      const snap = get().siteSnapshot;
      const configured = snap?.positions.find((p) => p.fp_id === d.fp_id);
      const nozzle = configured?.nozzles.find((n) => n.index === d.nozzle_index);
      const next = [...get().states];
      const i = next.findIndex((s) => s.fp_id === d.fp_id);
      if (i >= 0) {
        next[i] = {
          ...next[i],
          status: "PRE_AUTHORIZED",
          price: d.price,
          nozzle_index: d.nozzle_index,
          pre_auth_preset: d.preset,
          volume: 0,
          amount: 0,
          base_volume: null,
          base_amount: null,
          segment_volume: null,
          segment_amount: null,
          product_id: nozzle?.product_id ?? next[i]!.product_id,
          product_name: nozzle?.product_name ?? next[i]!.product_name,
          product_color: nozzle?.product_color ?? next[i]!.product_color,
        };
        set({ states: next, lastSaleOutcome: cleared });
      }
      return;
    }
    if (ev.event === "fp.nozzle_removed") {
      const { fp_id } = ev.data;
      const prev = get().states.find((s) => s.fp_id === fp_id);
      const next = [...get().states];
      const i = next.findIndex((s) => s.fp_id === fp_id);
      if (i >= 0 && prev) {
        next[i] = {
          ...prev,
          status: "DONE",
          stopped_tx_id: null,
          stop_source: null,
          base_volume: null,
          base_amount: null,
          segment_volume: null,
          segment_amount: null,
        };
        set({
          states: next,
          nozzleRemovedAt: { ...get().nozzleRemovedAt, [fp_id]: Date.now() },
          holdDoneUntil: {
            ...get().holdDoneUntil,
            [fp_id]: Date.now() + DONE_DISPLAY_HOLD_MS,
          },
        });
      }
      return;
    }
    if (ev.event === "service.price_updated") {
      const d = ev.data;
      const snap = get().siteSnapshot;
      if (snap) {
        const positions = snap.positions.map((fp) => {
          if (fp.fp_id !== d.fp_id) return fp;
          return {
            ...fp,
            nozzles: fp.nozzles.map((n) =>
              n.index === d.nozzle_index ? { ...n, price: d.new_price } : n,
            ),
          };
        });
        set({ siteSnapshot: { ...snap, positions } });
      }
      const next = [...get().states];
      const i = next.findIndex((s) => s.fp_id === d.fp_id);
      if (i >= 0 && next[i]!.nozzle_index === d.nozzle_index) {
        next[i] = { ...next[i]!, price: d.new_price };
        set({ states: next });
      }
      return;
    }
    if (ev.event === "fp.pre_auth_timeout") {
      set({ preAuthTimeoutFpId: ev.data.fp_id });
      return;
    }
    if (ev.event === "fp.pre_auth_nozzle_mismatch") {
      const d = ev.data;
      const snapshot = get().siteSnapshot;
      const nozzles =
        snapshot?.positions.find((fp) => fp.fp_id === d.fp_id)?.nozzles ?? [];
      set({
        preAuthNozzleMismatch: buildPreAuthNozzleMismatch(
          d.fp_id,
          d.expected_product_name,
          d.lifted_product_name,
          nozzles,
          snapshot,
        ),
      });
      return;
    }
    if (ev.event === "fp.pre_auth_cancelled") {
      const fpId = ev.data.fp_id;
      const cleared = { ...get().lastSaleOutcome };
      delete cleared[fpId];
      const holdDoneUntil = { ...get().holdDoneUntil };
      delete holdDoneUntil[fpId];
      const next = [...get().states];
      const i = next.findIndex((s) => s.fp_id === fpId);
      if (i >= 0) {
        next[i] = {
          ...next[i],
          status: "IDLE",
          pre_auth_preset: null,
          volume: 0,
          amount: 0,
          base_volume: null,
          base_amount: null,
          segment_volume: null,
          segment_amount: null,
          nozzle_index: null,
          product_id: null,
          product_name: null,
          product_color: null,
        };
        set({
          states: next,
          lastSaleOutcome: cleared,
          holdDoneUntil,
          preAuthNozzleMismatch: null,
          preAuthTimeoutFpId: null,
        });
      } else {
        set({ preAuthNozzleMismatch: null, preAuthTimeoutFpId: null });
      }
      return;
    }
    if (ev.event === "fp.online") {
      const { fp_id } = ev.data;
      const next = [...get().states];
      const i = next.findIndex((s) => s.fp_id === fp_id);
      if (i >= 0) {
        next[i] = { ...next[i]!, status: "IDLE" };
        set({ states: next });
      }
      return;
    }
    if (ev.event === "fp.offline") {
      const { fp_id } = ev.data;
      const next = [...get().states];
      const i = next.findIndex((s) => s.fp_id === fp_id);
      if (i >= 0) {
        next[i] = { ...next[i]!, status: "OFFLINE", pre_auth_preset: null };
        set({ states: next });
      }
      return;
    }
    if (ev.event === "fp.nozzle_up") {
      const d = ev.data;
      const next = [...get().states];
      const i = next.findIndex((s) => s.fp_id === d.fp_id);
      if (i >= 0) {
        const prev = next[i]!;
        const prevTag =
          typeof prev.status === "object" && prev.status !== null && "STOPPED" in prev.status
            ? "STOPPED"
            : prev.status;
        const keepPreAuth =
          prevTag === "PRE_AUTHORIZED" && prev.pre_auth_preset != null;
        const holdDoneUntil = { ...get().holdDoneUntil };
        // Lifting a different grade must not replay the completed-sale screen.
        if (
          prevTag === "DONE" &&
          prev.nozzle_index != null &&
          prev.nozzle_index !== d.nozzle_index
        ) {
          delete holdDoneUntil[d.fp_id];
        }
        next[i] = {
          ...prev,
          status: keepPreAuth ? "PRE_AUTHORIZED" : "NOZZLE_UP",
          nozzle_index: d.nozzle_index,
          product_id: d.product_id,
          product_name: d.product_name,
          product_color: d.product_color,
          price: d.price,
          volume: 0,
          amount: 0,
          base_volume: null,
          base_amount: null,
          segment_volume: null,
          segment_amount: null,
        };
        set({ states: next, holdDoneUntil });
      }
      return;
    }
    if (ev.event === "shift.started") {
      set({ currentShift: ev.data, shiftWarningMinutes: null });
      return;
    }
    if (ev.event === "shift.ended") {
      set({ currentShift: null, shiftWarningMinutes: null });
      return;
    }
    if (ev.event === "shift.handover") {
      set({ currentShift: ev.data.incoming, shiftWarningMinutes: null });
      return;
    }
    if (ev.event === "shift.warning") {
      set({ shiftWarningMinutes: ev.data.minutes_remaining });
      return;
    }
    if (ev.event === "tank.updated") {
      const snap = get().siteSnapshot;
      if (snap) {
        set({ siteSnapshot: { ...snap, tanks: ev.data.tanks } });
      }
    }
  },
}));
