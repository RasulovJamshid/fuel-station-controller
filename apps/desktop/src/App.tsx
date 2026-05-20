import { useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "./components/Header";
import { WorkspaceNav, type WorkspaceTabId } from "./components/WorkspaceNav";
import { DispenserCard, type AuthorizeRequest } from "./components/DispenserCard";
import { StatsPanel } from "./components/StatsPanel";
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

const WORKSPACE_TABS: { id: WorkspaceTabId; label: string; shortLabel?: string; primary?: boolean }[] = [
  { id: "dispensers", label: "Dispensers", shortLabel: "Pumps", primary: true },
  { id: "shift", label: "Shift", shortLabel: "Shift" },
  { id: "reservoirs", label: "Reservoirs", shortLabel: "Tanks" },
  { id: "history", label: "History", shortLabel: "Hist." },
  { id: "today", label: "Today", shortLabel: "Today" },
  { id: "admin", label: "Admin" },
];

export default function App() {
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTabId>("dispensers");
  const [adminToken, setAdminTokenState] = useState<string | null>(() => getAdminToken());
  const [adminPinOpen, setAdminPinOpen] = useState(false);
  const [mustChangePin, setMustChangePin] = useState(false);
  const states = useAppStore((s) => s.states);
  const siteSnapshot = useAppStore((s) => s.siteSnapshot);
  const simOnline = useAppStore((s) => s.simOnline);
  const setInvokeError = useAppStore((s) => s.setInvokeError);
  const smallScreen = useAppStore((s) => s.smallScreen);
  const theme = useAppStore((s) => s.theme);
  const setPreAuthNozzleMismatch = useAppStore((s) => s.setPreAuthNozzleMismatch);
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

  const syncSimPreauthExpectation = useCallback(
    async (fpId: string) => {
      if (!simOnline) return;
      const fp = useAppStore.getState().states.find((s) => s.fp_id === fpId);
      if (
        !fp ||
        (statusTag(fp.status) !== "PRE_AUTHORIZED" && fp.pre_auth_preset == null) ||
        fp.nozzle_index == null ||
        fp.product_id == null
      ) {
        return;
      }
      const nozzles = nozzlesByFp.get(fpId) ?? [];
      const n = nozzles.find((nz) => nz.index === fp.nozzle_index);
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("sim_set_preauth_expectation", {
        fpId,
        nozzle: fp.nozzle_index,
        product: fp.product_id,
        productName: fp.product_name ?? n?.product_name ?? null,
      });
    },
    [simOnline, nozzlesByFp],
  );

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

  const stats = useMemo(() => {
    const liters = sorted.reduce((a, s) => a + (s.volume || 0), 0);
    const sumApprox = sorted.reduce((a, s) => a + (s.amount || 0), 0);
    return { lanes: sorted.length, liters: Math.round(liters), sumM: sumApprox / 1_000_000 };
  }, [sorted]);

  const dispenserLayout = useMemo(() => {
    const n = sorted.length;
    if (smallScreen) {
      // In small-screen mode always force compact cards with a tight grid
      if (n <= 2) return { gridClass: "grid-cols-1", compact: true };
      if (n <= 4) return { gridClass: "grid-cols-2", compact: true };
      return { gridClass: "grid-cols-2 lg:grid-cols-3", compact: true };
    }
    if (n <= 4) {
      return {
        gridClass: "max-w-[1400px] grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
        compact: false,
      };
    }
    if (n <= 6) {
      return {
        gridClass: "max-w-[1600px] grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
        compact: true,
      };
    }
    return {
      gridClass: "max-w-[1800px] grid-cols-2 lg:grid-cols-4",
      compact: true,
    };
  }, [sorted.length, smallScreen]);

  const openEnd = useCallback(() => {
    if (shift.currentShift) shift.setShowEndModal(true);
  }, [shift]);

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
      <main className={`flex min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary ${smallScreen ? "pb-[2.75rem]" : "pb-[3.5rem]"}`}>
        {workspaceTab === "dispensers" ? (
          <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${smallScreen ? "p-1.5" : "p-3 md:p-4"}`}>
            <div className={`mx-auto grid items-stretch ${smallScreen ? "gap-1.5" : "gap-3"} ${dispenserLayout.gridClass}`}>
              {sorted.map((s) => (
                <DispenserCard
                  key={s.fp_id}
                  state={s}
                  fpNozzles={nozzlesByFp.get(s.fp_id) ?? []}
                  positionActive={positionActiveByFp.get(s.fp_id) ?? true}
                  defaultAuthMode={defaultAuthMode}
                  compact={dispenserLayout.compact}
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
          </div>
        ) : (
          <div className={`flex h-full min-h-0 flex-1 flex-col overflow-hidden ${smallScreen ? "p-2" : "p-4 md:p-6"}`}>
            {workspaceTab === "reservoirs" ? <ReservoirsPanel /> : null}
            {workspaceTab === "history" ? <HistoryPanel visible /> : null}
            {workspaceTab === "today" ? (
              <StatsPanel lanes={stats.lanes} liters={stats.liters} sumM={stats.sumM} />
            ) : null}
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
                <p className="text-sm text-slate-400">Enter the admin PIN to unlock this panel.</p>
              )
            ) : null}
          </div>
        )}
      </main>
      <WorkspaceNav
        tabs={WORKSPACE_TABS}
        active={workspaceTab}
        smallScreen={smallScreen}
        onSelect={(id) => {
          if (id === "admin" && !getAdminToken()) {
            setAdminPinOpen(true);
          }
          setWorkspaceTab(id);
        }}
      />
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
