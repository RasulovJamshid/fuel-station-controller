import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Header } from "./components/Header";
import { WorkspaceNav, type WorkspaceTabId } from "./components/WorkspaceNav";
import { DispenserCard, type AuthorizeRequest } from "./components/DispenserCard";
import { DispenserRow } from "./components/DispenserRow";
import { ClassicDispenserConsole } from "./components/ClassicDispenserConsole";
import { ReservoirsPanel } from "./components/ReservoirsPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { DashboardRecentTransactions } from "./components/DashboardRecentTransactions";
import { DashboardTanksMini } from "./components/DashboardTanksMini";
import { ShiftWorkspace } from "./components/shift/ShiftWorkspace";
import { ShiftStartModal } from "./components/shift/ShiftStartModal";
import { ShiftEndModal } from "./components/shift/ShiftEndModal";
import { ShiftHandoverModal } from "./components/shift/ShiftHandoverModal";
import { AdminPanel, getAdminToken, setAdminToken } from "./components/admin/AdminPanel";
import { AdminPinModal } from "./components/admin/AdminPinModal";
import {
  useBootstrapHealth,
  useBootstrapSiteConfig,
  useBootstrapStatus,
  useProbeSim,
  useServiceEvents,
  useStatusPoll,
} from "./hooks/useServiceEvents";
import { useShift } from "./hooks/useShift";
import { refreshFpStatus, waitForPreAuthorized } from "./simStatusRefresh";
import { useAppStore } from "./store";
import type { FpState, NozzleSnapshot } from "./types/api";

function statusTag(raw: FpState["status"]): string {
  if (typeof raw === "object" && raw !== null && "STOPPED" in raw) return "STOPPED";
  return String(raw);
}

const WORKSPACE_TAB_IDS: WorkspaceTabId[] = ["dispensers", "shift", "reservoirs", "history", "admin"];
const SELECTED_DISPENSER_FRAME_CLASS =
  "bg-accent-blue/10 ring-[3px] ring-accent-blue ring-offset-2 ring-offset-bg-primary shadow-[0_0_0_1px_rgb(var(--color-accent-blue)/0.2),0_10px_24px_-18px_rgb(var(--color-accent-blue)/0.7)]";

export default function App() {
  const { t } = useTranslation();

  const WORKSPACE_TABS = useMemo(
    () => WORKSPACE_TAB_IDS.map((id) => ({
      id,
      label: t(`nav.${id}`),
      shortLabel: t(`nav.${id}_short`),
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, /* re-compute when language changes */ t("nav.dispensers")],
  );

  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTabId>("dispensers");
  const [adminToken, setAdminTokenState] = useState<string | null>(() => getAdminToken());
  const [adminPinOpen, setAdminPinOpen] = useState(false);
  const [mustChangePin, setMustChangePin] = useState(false);
  const [activeDispenserFpId, setActiveDispenserFpId] = useState<string | null>(null);
  const [hiddenFps, setHiddenFps] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("hiddenFps");
      return raw ? new Set<string>(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  });
  const states = useAppStore((s) => s.states);
  const siteSnapshot = useAppStore((s) => s.siteSnapshot);
  const simOnline = useAppStore((s) => s.simOnline);
  const setInvokeError = useAppStore((s) => s.setInvokeError);
  const smallScreen = useAppStore((s) => s.smallScreen);
  const theme = useAppStore((s) => s.theme);
  const dispenserLayoutMode = useAppStore((s) => s.dispenserLayout);
  const clearPreAuthNozzleMismatch = useAppStore((s) => s.clearPreAuthNozzleMismatch);
  const setStates = useAppStore((s) => s.setStates);

  const shift = useShift();

  // Apply stored theme to <html> on startup and whenever it changes
  useEffect(() => {
    if (theme === "light") {
      document.documentElement.classList.add("light");
    } else {
      document.documentElement.classList.remove("light");
    }
  }, [theme]);

  useServiceEvents();
  useStatusPoll();
  useBootstrapStatus();
  useBootstrapSiteConfig();
  useBootstrapHealth();
  useProbeSim();

  const sorted = useMemo(
    () => [...states].sort((a, b) => a.fp_id.localeCompare(b.fp_id)),
    [states],
  );
  const visibleSorted = useMemo(() => sorted.filter((s) => !hiddenFps.has(s.fp_id)), [sorted, hiddenFps]);
  const hiddenSorted = useMemo(() => sorted.filter((s) => hiddenFps.has(s.fp_id)), [sorted, hiddenFps]);
  const dispenserRefs = useRef(new Map<string, HTMLDivElement>());

  const nozzlesByFp = useMemo(() => {
    const m = new Map<string, NozzleSnapshot[]>();
    if (!siteSnapshot) return m;
    for (const p of siteSnapshot.positions) {
      if (p.active) m.set(p.fp_id, p.nozzles);
    }
    return m;
  }, [siteSnapshot]);

  const positionActiveByFp = useMemo(() => {
    const m = new Map<string, boolean>();
    if (!siteSnapshot) return m;
    for (const p of siteSnapshot.positions) {
      m.set(p.fp_id, p.active);
    }
    return m;
  }, [siteSnapshot]);

  const defaultAuthMode = siteSnapshot?.default_auth_mode ?? "preauth";
  const useStopMode = siteSnapshot?.use_stop_mode ?? false;
  const useCancelMode = siteSnapshot?.use_cancel_mode ?? false;
  const gilbarcoMode = (siteSnapshot?.protocol ?? "").toLowerCase().includes("gilbarco");

  // Shift requirement: operators must start a shift before authorizing dispensers.
  const shiftRequired = shift.mode !== "disabled" && !shift.currentShift;
  const openStartShift = useCallback(() => shift.setShowStartModal(true), [shift]);

  const onAuthorize = useCallback(
    async (req: AuthorizeRequest) => {
      if (shiftRequired) { shift.setShowStartModal(true); return; }
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        const pl: Record<string, unknown> = {
          fpId: req.fpId,
          nozzleIndex: req.nozzleIndex === null ? null : req.nozzleIndex,
          presetKind: req.fillMode,
          presetValue: req.fillMode === "full" ? null : req.limitValue,
        };
        if (req.priceOverride != null) pl.priceOverride = req.priceOverride;
        await invoke("authorize", pl);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        console.error("authorize failed", e);
      }
    },
    [shiftRequired, shift, setInvokeError],
  );

  const fetchAllStatus = useCallback(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<FpState[]>("get_all_status");
  }, []);


  const onPreAuthorize = useCallback(
    async (req: AuthorizeRequest) => {
      if (shiftRequired) { shift.setShowStartModal(true); return; }
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        const pl: Record<string, unknown> = {
          fpId: req.fpId,
          nozzleIndex: req.nozzleIndex === null ? null : req.nozzleIndex,
          presetKind: req.fillMode,
          presetValue: req.fillMode === "full" ? null : req.limitValue,
        };
        if (req.priceOverride != null) pl.priceOverride = req.priceOverride;
        if (simOnline && req.nozzleIndex != null) {
          const nozzles = nozzlesByFp.get(req.fpId) ?? [];
          const n = nozzles.find((nz) => nz.index === req.nozzleIndex);
          if (n) {
            await invoke("sim_set_preauth_expectation", {
              fpId: req.fpId,
              nozzle: n.index,
              product: n.product_id,
              productName: n.product_name,
            });
          }
        }
        await invoke("preauthorize", pl);
        await waitForPreAuthorized(req.fpId, fetchAllStatus, { timeoutMs: 4000 });
        const rows = await refreshFpStatus(fetchAllStatus, { rounds: 3 });
        setStates(rows);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        console.error("preauthorize failed", e);
      }
    },
    [shiftRequired, shift, setInvokeError, simOnline, nozzlesByFp, fetchAllStatus, setStates],
  );

  const onCancelPreAuth = useCallback(
    async (fpId: string) => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        await invoke("cancel_preauth", { fpId });
        const rows = await refreshFpStatus(fetchAllStatus, { rounds: 3 });
        setStates(rows);
        clearPreAuthNozzleMismatch();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        console.error("cancel_preauth failed", e);
      }
    },
    [setInvokeError, fetchAllStatus, setStates, clearPreAuthNozzleMismatch],
  );

  const onStop = useCallback(
    async (fpId: string) => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        await invoke("stop_dispenser", { fpId });
        const rows = await invoke<import("./types/api").FpState[]>("get_all_status");
        setStates(rows);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        console.error("stop_dispenser failed", e);
      }
    },
    [setInvokeError, setStates],
  );

  const onCancel = useCallback(
    async (fpId: string) => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        await invoke("stop_dispenser", { fpId });
        const rows = await invoke<import("./types/api").FpState[]>("get_all_status");
        setStates(rows);
        const stoppedTxId = rows.find((r) => r.fp_id === fpId)?.stopped_tx_id;
        if (stoppedTxId) {
          await invoke("close_stopped_transaction", { fpId, stoppedTxId });
          const updated = await invoke<import("./types/api").FpState[]>("get_all_status");
          setStates(updated);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        console.error("cancel_fill failed", e);
      }
    },
    [setInvokeError, setStates],
  );

  const onResumeFill = useCallback(
    async (fpId: string, stoppedTxId: string) => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        await invoke("resume_fill", { fpId, stoppedTxId });
        if (useAppStore.getState().simOnline) {
          const nozzles = nozzlesByFp.get(fpId) ?? [];
          const active = nozzles.filter((n) => n.active);
          const n = active.length === 1 ? active[0] : undefined;
          try {
            const payload: Record<string, unknown> = { fpId };
            if (n) {
              payload.nozzle = n.index;
              payload.product = n.product_id;
            }
            await invoke("sim_nozzle_up", payload);
          } catch (simErr) {
            console.warn("sim_nozzle_up after resume (hose-in-tank sim kick)", simErr);
          }
        }
        const rows = await invoke<import("./types/api").FpState[]>("get_all_status");
        setStates(rows);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        console.error("resume_fill failed", e);
      }
    },
    [setInvokeError, setStates, nozzlesByFp],
  );

  const onContinueFill = useCallback(
    async (fpId: string, stoppedTxId: string) => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        await invoke("continue_fill", { fpId, stoppedTxId });
        if (useAppStore.getState().simOnline) {
          const nozzles = nozzlesByFp.get(fpId) ?? [];
          const active = nozzles.filter((n) => n.active);
          const n = active.length === 1 ? active[0] : undefined;
          try {
            const payload: Record<string, unknown> = { fpId };
            if (n) {
              payload.nozzle = n.index;
              payload.product = n.product_id;
            }
            await invoke("sim_nozzle_up", payload);
          } catch (simErr) {
            console.warn("sim_nozzle_up after continue (lift manually if needed)", simErr);
          }
        }
        const rows = await invoke<import("./types/api").FpState[]>("get_all_status");
        setStates(rows);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        console.error("continue_fill failed", e);
      }
    },
    [setInvokeError, setStates, nozzlesByFp],
  );

  const onCloseStopped = useCallback(
    async (fpId: string, stoppedTxId: string) => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        if (gilbarcoMode) {
          await invoke("dismiss_sale", { fpId });
          const rows = await invoke<import("./types/api").FpState[]>("get_all_status");
          setStates(rows);
        } else {
          await invoke("close_stopped_transaction", { fpId, stoppedTxId });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        console.error("close_stopped_transaction failed", e);
      }
    },
    [setInvokeError, gilbarcoMode, setStates],
  );

  const toggleHideFp = useCallback((fpId: string) => {
    setHiddenFps((prev) => {
      const next = new Set(prev);
      if (next.has(fpId)) next.delete(fpId);
      else next.add(fpId);
      try { localStorage.setItem("hiddenFps", JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const clearSaleDisplay = useAppStore((s) => s.clearSaleDisplay);

  const onDismissSale = useCallback(
    async (fpId: string) => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        await invoke("dismiss_sale", { fpId });
        clearSaleDisplay(fpId);
        const rows = await invoke<import("./types/api").FpState[]>("get_all_status");
        setStates(rows);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        console.error("dismiss_sale failed", e);
      }
    },
    [setInvokeError, clearSaleDisplay, setStates],
  );

  const dispenserLayout = useMemo(() => {
    const n = visibleSorted.length;
    if (smallScreen) {
      if (n <= 2) return { gridClass: "grid-cols-1", gridStyle: undefined, compact: true };
      if (n <= 6) return { gridClass: "grid-cols-1 sm:grid-cols-2", gridStyle: undefined, compact: true };
      return { gridClass: "grid-cols-1 sm:grid-cols-2 md:grid-cols-3", gridStyle: undefined, compact: true };
    }
    const desktopCols = Math.min(Math.max(n, 1), 6);
    const minColWidth = desktopCols <= 2 ? "14rem" : desktopCols <= 4 ? "12rem" : "10rem";
    return {
      gridClass: "max-w-[112rem] justify-center",
      gridStyle: { gridTemplateColumns: `repeat(${desktopCols}, minmax(${minColWidth}, 1fr))` },
      compact: true,
    };
  }, [visibleSorted.length, smallScreen]);

  const openEnd = useCallback(() => {
    if (shift.currentShift) shift.setShowEndModal(true);
  }, [shift]);

  useEffect(() => {
    if (workspaceTab !== "dispensers") return;
    if (visibleSorted.length === 0) {
      setActiveDispenserFpId(null);
      return;
    }
    const exists = activeDispenserFpId != null && visibleSorted.some((s) => s.fp_id === activeDispenserFpId);
    if (!exists) setActiveDispenserFpId(visibleSorted[0].fp_id);
  }, [workspaceTab, visibleSorted, activeDispenserFpId]);

  const setDispenserRef = useCallback((fpId: string, el: HTMLDivElement | null) => {
    if (el) dispenserRefs.current.set(fpId, el);
    else dispenserRefs.current.delete(fpId);
  }, []);

  const focusDispenserByIndex = useCallback((index: number) => {
    if (index < 0 || index >= visibleSorted.length) return;
    const fpId = visibleSorted[index]?.fp_id;
    if (!fpId) return;
    setActiveDispenserFpId(fpId);
    const el = dispenserRefs.current.get(fpId);
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [visibleSorted]);

  const activatePrimaryAction = useCallback((fpId: string) => {
    const el = dispenserRefs.current.get(fpId);
    if (!el) return;
    const actionZone = el.querySelector<HTMLElement>("[data-dispenser-action-zone='true']");
    if (!actionZone) return;
    // Click the first non-disabled, keyboard-eligible button.
    // Pause and Cancel Pre-Auth carry data-no-keyboard and are mouse-only.
    actionZone.querySelector<HTMLButtonElement>("button:not([disabled]):not([data-no-keyboard])")?.click();
  }, []);

  const onDispenserKeyDown = useCallback((fpId: string, e: React.KeyboardEvent<HTMLDivElement>) => {
    if (workspaceTab !== "dispensers") return;
    if (document.querySelector("[data-fill-setup-modal='true']")) return;
    const idx = visibleSorted.findIndex((s) => s.fp_id === fpId);
    if (idx < 0) return;

    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusDispenserByIndex((idx + 1) % visibleSorted.length);
      return;
    }

    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusDispenserByIndex((idx - 1 + visibleSorted.length) % visibleSorted.length);
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activatePrimaryAction(fpId);
    }
  }, [workspaceTab, visibleSorted, focusDispenserByIndex, activatePrimaryAction]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "F12") return;
      e.preventDefault();
      setWorkspaceTab((current) => current === "history" ? "dispensers" : "history");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Global keydown: lets the user start navigating with arrow keys immediately,
  // without first having to click a dispenser card.
  useEffect(() => {
    if (workspaceTab !== "dispensers") return;
    const handler = (e: KeyboardEvent) => {
      const focused = document.activeElement as HTMLElement | null;
      // Already inside a dispenser card — onKeyDown handles it.
      if (focused?.closest("[data-dispenser-focusable]")) return;
      // Inside any dialog — don't interfere.
      if (focused?.closest("[role='dialog']")) return;
      // Focus is on a real interactive element outside the dispenser grid — don't steal.
      if (focused && focused !== document.body &&
        ["BUTTON", "INPUT", "TEXTAREA", "SELECT", "A"].includes(focused.tagName)) return;

      const isArrow = e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight";
      const isActivate = e.key === "Enter" || e.key === " ";

      if (isArrow) {
        e.preventDefault();
        const idx = activeDispenserFpId
          ? Math.max(0, visibleSorted.findIndex((s) => s.fp_id === activeDispenserFpId))
          : 0;
        focusDispenserByIndex(idx);
      } else if (isActivate && activeDispenserFpId) {
        e.preventDefault();
        activatePrimaryAction(activeDispenserFpId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspaceTab, visibleSorted, activeDispenserFpId, focusDispenserByIndex, activatePrimaryAction]);

  const handleSelectTab = useCallback(
    (id: WorkspaceTabId) => {
      if (id === "admin" && !getAdminToken()) {
        setAdminPinOpen(true);
      }
      setWorkspaceTab(id);
    },
    [setWorkspaceTab],
  );

  const workspaceNavProps = {
    tabs: WORKSPACE_TABS,
    active: workspaceTab,
    smallScreen,
    onSelect: handleSelectTab,
  };

  return (
    <div className="flex h-dvh max-h-dvh flex-col overflow-hidden">
      <Header
        shift={{
          mode: shift.mode,
          currentShift: shift.currentShift,
          warningMinutes: shift.warningMinutes,
          onStartShift: () => shift.setShowStartModal(true),
          onEndShift: openEnd,
          onHandover: () => shift.setShowHandoverModal(true),
        }}
        onOpenWorkspace={(tab) => {
          if (tab === "admin" && !getAdminToken()) {
            setAdminPinOpen(true);
          }
          setWorkspaceTab(tab);
        }}
      />
      <ShiftStartModal
        open={shift.showStartModal}
        requirePin={shift.requirePin}
        onClose={() => shift.setShowStartModal(false)}
        onConfirm={shift.startShift}
      />
      <ShiftEndModal
        open={shift.showEndModal}
        shift={shift.currentShift}
        onClose={() => shift.setShowEndModal(false)}
        onConfirm={(shiftId, notes) => shift.endShift({ shift_id: shiftId, notes })}
      />
      <ShiftHandoverModal
        open={shift.showHandoverModal}
        outgoingShift={shift.currentShift}
        requirePin={shift.requirePin}
        onClose={() => shift.setShowHandoverModal(false)}
        onConfirm={shift.handover}
      />
      <div className={`flex min-h-0 flex-1 overflow-hidden ${smallScreen ? "flex-row" : "lg:flex-row"}`}>
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
          {workspaceTab === "dispensers" ? (
            <div className={`min-h-0 flex-1 ${smallScreen ? "overflow-y-auto overscroll-contain p-2" : "overflow-hidden p-2 md:p-3"}`}>
              {dispenserLayoutMode === "classic" ? (
                <ClassicDispenserConsole
                  states={visibleSorted}
                  nozzlesByFp={nozzlesByFp}
                  positionActiveByFp={positionActiveByFp}
                  activeFpId={activeDispenserFpId}
                  onSelectFp={setActiveDispenserFpId}
                  defaultAuthMode={defaultAuthMode}
                  onAuthorize={onAuthorize}
                  onPreAuthorize={onPreAuthorize}
                  onCancelPreAuth={onCancelPreAuth}
                  onStop={onStop}
                  onCancel={onCancel}
                  onResumeFill={onResumeFill}
                  onContinueFill={onContinueFill}
                  onCloseStopped={onCloseStopped}
                  shiftRequired={shiftRequired}
                  onStartShift={openStartShift}
                  useStopMode={useStopMode}
                  useCancelMode={useCancelMode}
                  gilbarcoMode={gilbarcoMode}
                />
              ) : smallScreen ? (
                /* ── Compact rows, always single column ── */
                <div className="flex w-full flex-col gap-4 p-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    {sorted.map((s) => {
                      const hidden = hiddenFps.has(s.fp_id);
                      const isOffline = statusTag(s.status) === "OFFLINE";
                      const title = s.label?.trim() || (s.fp_id.match(/\d+/)?.[0] ? `${s.fp_id.match(/\d+/)![0]}-KOLONKA` : s.fp_id);
                      return (
                        <button
                          key={s.fp_id}
                          type="button"
                          onClick={() => toggleHideFp(s.fp_id)}
                          title={hidden ? t("dispenser.show") : t("dispenser.hideCard")}
                          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                            hidden
                              ? "border-border-primary/40 bg-bg-secondary/50 text-text-muted opacity-60 hover:opacity-100 hover:text-text-secondary"
                              : "border-accent-emerald/40 bg-accent-emerald/8 text-text-secondary hover:border-border-primary hover:bg-bg-secondary"
                          }`}
                        >
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${!isOffline ? "bg-accent-emerald" : "bg-text-muted"}`} />
                          {title}
                        </button>
                      );
                    })}
                  </div>
                  <div className="grid w-full grid-cols-1 gap-2">
                  {visibleSorted.map((s) => (
                    <div
                      key={s.fp_id}
                      ref={(el) => setDispenserRef(s.fp_id, el)}
                      tabIndex={activeDispenserFpId === s.fp_id ? 0 : -1}
                      data-dispenser-focusable="true"
                      className={`relative rounded-xl outline-none transition-[box-shadow] duration-150 ${
                        activeDispenserFpId === s.fp_id
                          ? SELECTED_DISPENSER_FRAME_CLASS
                          : ""
                      } focus-visible:ring-2 focus-visible:ring-accent-blue focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary`}
                      onFocus={() => setActiveDispenserFpId(s.fp_id)}
                      onClick={() => setActiveDispenserFpId(s.fp_id)}
                      onKeyDown={(e) => onDispenserKeyDown(s.fp_id, e)}
                    >
                      {activeDispenserFpId === s.fp_id ? (
                        <div className="pointer-events-none absolute inset-x-4 top-0 z-20 h-1 rounded-b-full bg-accent-blue shadow-[0_1px_4px_rgb(var(--color-accent-blue)/0.45)]" aria-hidden />
                      ) : null}
                      <DispenserRow
                        state={s}
                        fpNozzles={nozzlesByFp.get(s.fp_id) ?? []}
                        positionActive={positionActiveByFp.get(s.fp_id) ?? true}
                        defaultAuthMode={defaultAuthMode}
                        compact
                        onAuthorize={onAuthorize}
                        onPreAuthorize={onPreAuthorize}
                        onCancelPreAuth={onCancelPreAuth}
                        onStop={onStop}
                        onCancel={onCancel}
                        onResumeFill={onResumeFill}
                        onContinueFill={onContinueFill}
                        onCloseStopped={onCloseStopped}
                        onDismissSale={onDismissSale}
                        shiftRequired={shiftRequired}
                        onStartShift={openStartShift}
                        useStopMode={useStopMode}
                        useCancelMode={useCancelMode}
                        gilbarcoMode={gilbarcoMode}
                      />
                    </div>
                  ))}
                  </div>
                </div>
              ) : (
                <div className="flex h-full min-h-0 flex-col gap-3">
                  <section className="flex min-h-0 flex-[6] flex-col overflow-hidden rounded-2xl border border-border-primary/70 bg-bg-card/60 p-2 md:p-3">
                    {hiddenSorted.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pb-2">
                        {hiddenSorted.map((s) => {
                          const isOffline = statusTag(s.status) === "OFFLINE";
                          const title =
                            s.label?.trim() ||
                            (s.fp_id.match(/\d+/)?.[0]
                              ? `${s.fp_id.match(/\d+/)![0]}-KOLONKA`
                              : s.fp_id);
                          return (
                            <button
                              key={s.fp_id}
                              type="button"
                              onClick={() => toggleHideFp(s.fp_id)}
                              className="flex items-center gap-1.5 rounded-lg border border-border-primary bg-bg-card px-2.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                            >
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${!isOffline ? "bg-accent-emerald" : "bg-text-muted"}`} />
                              {title}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className="min-h-0 flex-1">
                      <div
                        className={`mx-auto grid h-full w-full auto-rows-fr items-stretch gap-2 p-1.5 md:gap-3 md:p-2 ${dispenserLayout.gridClass}`}
                        style={dispenserLayout.gridStyle}
                      >
                        {visibleSorted.map((s) => (
                          <div
                            key={s.fp_id}
                            ref={(el) => setDispenserRef(s.fp_id, el)}
                            tabIndex={activeDispenserFpId === s.fp_id ? 0 : -1}
                            data-dispenser-focusable="true"
                            className={`relative min-h-0 rounded-xl outline-none transition-[box-shadow] duration-150 ${
                              activeDispenserFpId === s.fp_id
                                ? SELECTED_DISPENSER_FRAME_CLASS
                                : ""
                            } focus-visible:ring-2 focus-visible:ring-accent-blue focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary`}
                            onFocus={() => setActiveDispenserFpId(s.fp_id)}
                            onClick={() => setActiveDispenserFpId(s.fp_id)}
                            onKeyDown={(e) => onDispenserKeyDown(s.fp_id, e)}
                          >
                            {activeDispenserFpId === s.fp_id ? (
                              <div className="pointer-events-none absolute inset-x-4 top-0 z-20 h-1 rounded-b-full bg-accent-blue shadow-[0_1px_4px_rgb(var(--color-accent-blue)/0.45)]" aria-hidden />
                            ) : null}
                            <DispenserCard
                              state={s}
                              fpNozzles={nozzlesByFp.get(s.fp_id) ?? []}
                              positionActive={positionActiveByFp.get(s.fp_id) ?? true}
                              defaultAuthMode={defaultAuthMode}
                              compact={dispenserLayout.compact}
                              onHide={() => toggleHideFp(s.fp_id)}
                              onAuthorize={onAuthorize}
                              onPreAuthorize={onPreAuthorize}
                              onCancelPreAuth={onCancelPreAuth}
                              onStop={onStop}
                              onCancel={onCancel}
                              onResumeFill={onResumeFill}
                              onContinueFill={onContinueFill}
                              onCloseStopped={onCloseStopped}
                              onDismissSale={onDismissSale}
                              shiftRequired={shiftRequired}
                              onStartShift={openStartShift}
                              useStopMode={useStopMode}
                              useCancelMode={useCancelMode}
                              gilbarcoMode={gilbarcoMode}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>

                  <section className="grid min-h-[13rem] shrink-0 flex-[4] grid-cols-1 gap-3 overflow-hidden xl:grid-cols-12">
                    <div className="min-h-0 xl:col-span-7">
                      <DashboardRecentTransactions
                        onOpenHistory={() => setWorkspaceTab("history")}
                        shiftId={shift.mode === "disabled" ? undefined : (shift.currentShift?.id ?? null)}
                      />
                    </div>
                    <div className="min-h-0 xl:col-span-5">
                      <DashboardTanksMini />
                    </div>
                  </section>
                </div>
              )}
            </div>
          ) : (
            <div className={`flex h-full min-h-0 flex-1 flex-col overflow-hidden ${smallScreen ? "p-2" : "p-4 md:p-6"}`}>
              {workspaceTab === "reservoirs" ? <ReservoirsPanel /> : null}
              {workspaceTab === "history" ? <HistoryPanel visible compact={smallScreen} currentShift={shift.currentShift} /> : null}
{workspaceTab === "shift" ? (
                <ShiftWorkspace
                  mode={shift.mode}
                  schedule={shift.schedule}
                  currentShift={shift.currentShift}
                  recentShifts={shift.recentShifts}
                  onStart={() => shift.setShowStartModal(true)}
                  onHandover={() => shift.setShowHandoverModal(true)}
                  onEnd={openEnd}
                  onViewShiftTransactions={(shiftId) => {
                    // TODO: pass shiftId filter to HistoryPanel
                    setWorkspaceTab("history");
                  }}
                />
              ) : null}
              {workspaceTab === "admin" ? (
                adminToken ? (
                  <AdminPanel
                    token={adminToken}
                    mustChangePin={mustChangePin}
                    onPinChanged={() => setMustChangePin(false)}
                    onLogout={() => {
                      setAdminToken(null);
                      setAdminTokenState(null);
                      setWorkspaceTab("dispensers");
                    }}
                    onSessionExpired={() => {
                      setAdminToken(null);
                      setAdminTokenState(null);
                      setAdminPinOpen(true);
                    }}
                  />
                ) : (
                  <p className="text-sm text-slate-400">{t("adminPin.unlockPrompt")}</p>
                )
              ) : null}
            </div>
          )}
        </main>
        <aside className={`shrink-0 flex ${smallScreen ? "px-2" : "hidden px-4 lg:flex"}`}>
          <WorkspaceNav variant="desktop" {...workspaceNavProps} />
        </aside>
      </div>
      <AdminPinModal
        open={adminPinOpen}
        forceChange={mustChangePin}
        onSuccess={(token, must) => {
          setAdminToken(token);
          setAdminTokenState(token);
          setMustChangePin(must);
          setAdminPinOpen(false);
        }}
        onCancel={() => {
          setAdminPinOpen(false);
          if (!getAdminToken()) setWorkspaceTab("dispensers");
        }}
      />
    </div>
  );
}
