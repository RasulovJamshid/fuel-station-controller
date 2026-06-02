import { useCallback, useEffect, useState } from "react";
import type { EndShiftCmd, HandoverCmd, Shift, StartShiftCmd } from "../types/api";
import { useAppStore } from "../store";

export function useShift() {
  const siteSnapshot = useAppStore((s) => s.siteSnapshot);
  const currentShift = useAppStore((s) => s.currentShift);
  const warningMinutes = useAppStore((s) => s.shiftWarningMinutes);
  const setCurrentShift = useAppStore((s) => s.setCurrentShift);
  const setInvokeError = useAppStore((s) => s.setInvokeError);

  const [showStartModal, setShowStartModal] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [showHandoverModal, setShowHandoverModal] = useState(false);
  const [recentShifts, setRecentShifts] = useState<Shift[]>([]);

  // Default to manual until config loads; only hide shift UI when site explicitly disables it.
  const mode = siteSnapshot?.shift_mode ?? "manual";
  const requirePin = siteSnapshot?.require_operator_pin ?? false;
  const schedule = siteSnapshot?.shift_schedule ?? [];

  const refreshCurrent = useCallback(async () => {
    if (mode === "disabled") return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const shift = await invoke<Shift | null>("get_current_shift");
      setCurrentShift(shift);
    } catch (e) {
      console.error("get_current_shift failed", e);
    }
  }, [mode, setCurrentShift]);

  const refreshRecent = useCallback(async () => {
    if (mode === "disabled") return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const rows = await invoke<Shift[]>("list_shifts", {
        limit: 20,
        offset: 0,
        status: "CLOSED",
      });
      setRecentShifts(rows);
    } catch (e) {
      console.error("list_shifts failed", e);
    }
  }, [mode]);

  useEffect(() => {
    void refreshCurrent();
    void refreshRecent();
  }, [refreshCurrent, refreshRecent]);

  const startShift = useCallback(
    async (cmd: StartShiftCmd) => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        const shift = await invoke<Shift>("start_shift", {
          operatorName: cmd.operator_name,
          pin: cmd.pin ?? null,
          notes: cmd.notes ?? null,
          startedAtMs: cmd.started_at_override ?? null,
        });
        setCurrentShift(shift);
        setShowStartModal(false);
        await refreshRecent();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        throw e;
      }
    },
    [setCurrentShift, setInvokeError, refreshRecent],
  );

  const endShift = useCallback(
    async (cmd: EndShiftCmd) => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        await invoke<Shift>("end_shift", {
          shiftId: cmd.shift_id,
          notes: cmd.notes ?? null,
        });
        setCurrentShift(null);
        setShowEndModal(false);
        await refreshRecent();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        throw e;
      }
    },
    [setCurrentShift, setInvokeError, refreshRecent],
  );

  const handover = useCallback(
    async (cmd: HandoverCmd) => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setInvokeError(null);
        const res = await invoke<{ outgoing: Shift; incoming: Shift }>("handover_shift", {
          outgoingShiftId: cmd.outgoing_shift_id,
          incomingOperator: cmd.incoming_operator,
          incomingPin: cmd.incoming_pin ?? null,
          notes: cmd.notes ?? null,
        });
        setCurrentShift(res.incoming);
        setShowHandoverModal(false);
        await refreshRecent();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInvokeError(msg);
        throw e;
      }
    },
    [setCurrentShift, setInvokeError, refreshRecent],
  );

  return {
    mode,
    requirePin,
    schedule,
    currentShift,
    warningMinutes,
    recentShifts,
    showStartModal,
    setShowStartModal,
    showEndModal,
    setShowEndModal,
    showHandoverModal,
    setShowHandoverModal,
    startShift,
    endShift,
    handover,
    refreshCurrent,
    refreshRecent,
  };
}
