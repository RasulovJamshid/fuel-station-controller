import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Header } from "./components/Header";
import { WorkspaceNav, type WorkspaceTabId } from "./components/WorkspaceNav";
import { DispenserCard, type AuthorizeRequest } from "./components/DispenserCard";
import { DispenserRow } from "./components/DispenserRow";
import { ReservoirsPanel } from "./components/ReservoirsPanel";
import { HistoryPanel } from "./components/HistoryPanel";
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

  const onAuthorize = useCallback(
    async (req: AuthorizeRequest) => {
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
    [setInvokeError],
  );

  const fetchAllStatus = useCallback(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<FpState[]>("get_all_status");
  }, []);


  const onPreAuthorize = useCallback(
    async (req: AuthorizeRequest) => {
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
    [setInvokeError, simOnline, nozzlesByFp, fetchAllStatus, setStates],
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
        await invoke("close_stopped_transaction", { fpId, stoppedTxId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        console.error("close_stopped_transaction failed", e);
      }
    },
    [setInvokeError],
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
      if (n <= 4) return { gridClass: "grid-cols-2", gridStyle: undefined, compact: true };
      return { gridClass: "grid-cols-2 sm:grid-cols-3", gridStyle: undefined, compact: true };
    }
    // Desktop: auto-fit columns with a fixed min/max so cards keep their natural
    // size. Empty tracks collapse (auto-fit), leftover space is distributed evenly
    // (justify-evenly). max-w on the container prevents extreme spreading on
    // ultra-wide monitors.
    if (n <= 4) {
      return {
        gridClass: "max-w-[90rem] justify-evenly",
        gridStyle: { gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 26rem))" },
        compact: false,
      };
    }
    if (n <= 8) {
      return {
        gridClass: "max-w-[90rem] justify-evenly",
        gridStyle: { gridTemplateColumns: "repeat(auto-fit, minmax(17rem, 22rem))" },
        compact: true,
      };
    }
    return {
      gridClass: "max-w-[110rem] justify-evenly",
      gridStyle: { gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 18rem))" },
      compact: true,
    };
  }, [visibleSorted.length, smallScreen]);

  const openEnd = useCallback(() => {
    if (shift.currentShift) shift.setShowEndModal(true);
  }, [shift]);

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
            <div
              className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${smallScreen ? "p-2" : "p-2 md:p-3"}`}
            >
              {smallScreen ? (
                /* ── Compact list: one row per dispenser, fits 4-8 without scroll ── */
                <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
                  {visibleSorted.map((s) => (
                    <DispenserRow
                      key={s.fp_id}
                      state={s}
                      fpNozzles={nozzlesByFp.get(s.fp_id) ?? []}
                      positionActive={positionActiveByFp.get(s.fp_id) ?? true}
                      defaultAuthMode={defaultAuthMode}
                      compact
                      onAuthorize={onAuthorize}
                      onPreAuthorize={onPreAuthorize}
                      onCancelPreAuth={onCancelPreAuth}
                      onStop={onStop}
                      onResumeFill={onResumeFill}
                      onContinueFill={onContinueFill}
                      onCloseStopped={onCloseStopped}
                      onDismissSale={onDismissSale}
                    />
                  ))}
                </div>
              ) : (
                /* ── Standard card grid ── */
                <>
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
                  <div
                    className={`mx-auto grid w-full items-stretch gap-2 md:gap-3 ${dispenserLayout.gridClass}`}
                    style={dispenserLayout.gridStyle}
                  >
                    {visibleSorted.map((s) => (
                      <DispenserCard
                        key={s.fp_id}
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
                        onResumeFill={onResumeFill}
                        onContinueFill={onContinueFill}
                        onCloseStopped={onCloseStopped}
                        onDismissSale={onDismissSale}
                      />
                    ))}
                  </div>
                </>
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
