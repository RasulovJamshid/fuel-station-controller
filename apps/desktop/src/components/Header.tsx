import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../store";
import { ShiftBadge } from "./shift/ShiftBadge";
import { ShiftWarningBanner } from "./shift/ShiftWarningBanner";
import { ThemeToggleCompact } from "./ThemeToggle";
import type { FpState, Shift, ShiftMode } from "../types/api";

type HeaderShiftProps = {
  mode: ShiftMode;
  currentShift: Shift | null;
  warningMinutes: number | null;
  onStartShift: () => void;
  onEndShift: () => void;
  onHandover: () => void;
};

export function Header({ shift }: { shift: HeaderShiftProps }) {
  const siteName = useAppStore((s) => s.siteName);
  const connection = useAppStore((s) => s.connection);
  const ws = useAppStore((s) => s.wsConnected);
  const simOnline = useAppStore((s) => s.simOnline);
  const invokeError = useAppStore((s) => s.invokeError);
  const setInvokeError = useAppStore((s) => s.setInvokeError);
  const setStates = useAppStore((s) => s.setStates);
  const smallScreen = useAppStore((s) => s.smallScreen);
  const [now, setNow] = useState(() => new Date());

  const onEStopAll = useCallback(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      setInvokeError(null);
      await invoke("emergency_stop_all");
      const rows = await invoke<FpState[]>("get_all_status");
      setStates(rows);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInvokeError(msg);
      console.error("emergency_stop_all failed", e);
    }
  }, [setInvokeError, setStates]);

  const onResetAllLanes = useCallback(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      setInvokeError(null);
      await invoke("reset_all_lanes");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInvokeError(msg);
      console.error("reset_all_lanes failed", e);
    }
  }, [setInvokeError]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const time = now.toLocaleTimeString(undefined,
    smallScreen
      ? { hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  );

  const shiftEnabled = shift.mode !== "disabled";

  return (
    <header className="sticky top-0 z-30 border-b border-border-primary bg-bg-header/95 backdrop-blur-sm">
      {shiftEnabled ? (
        <ShiftWarningBanner
          minutesRemaining={shift.warningMinutes}
          onHandover={shift.onHandover}
          onEndShift={shift.onEndShift}
        />
      ) : null}
      <div className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 ${smallScreen ? "py-1.5" : "py-2.5 sm:px-6 sm:gap-x-4 sm:gap-y-2 sm:px-4"}`}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className={`font-semibold text-text-primary ${smallScreen ? "text-sm" : "text-base sm:text-lg"}`}>AZS</span>
            {!smallScreen && <span className="truncate text-sm text-text-secondary">{siteName}</span>}
          </div>
          {shiftEnabled ? (
            <ShiftBadge
              shift={shift.currentShift}
              mode={shift.mode}
              onStartShift={shift.onStartShift}
              onEndShift={shift.onEndShift}
              onHandover={shift.onHandover}
            />
          ) : null}
        </div>
        <div className={`flex flex-wrap items-center gap-1.5 ${smallScreen ? "text-xs" : "text-xs gap-2 sm:gap-3 sm:text-sm"}`}>
          <div className="flex items-center gap-1 rounded-md border border-border-primary bg-bg-secondary/60 px-0.5 py-0.5">
            <button
              type="button"
              title="Emergency stop all lanes"
              className={`rounded font-medium text-accent-red-light hover:bg-accent-red-dark/20 hover:text-text-inverse ${smallScreen ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1"}`}
              onClick={() => void onEStopAll()}
            >
              E‑STOP
            </button>
            <span className="h-3.5 w-px bg-border-primary" aria-hidden />
            <button
              type="button"
              title="Reset all lanes to idle"
              className={`rounded text-text-secondary hover:bg-bg-tertiary hover:text-text-primary ${smallScreen ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1"}`}
              onClick={() => void onResetAllLanes()}
            >
              Reset
            </button>
          </div>
          {!smallScreen && (
            <>
              <div
                className="hidden items-center gap-2 rounded-md border border-border-secondary bg-bg-secondary/50 px-2 py-1 text-xs sm:flex"
                title="Connection status"
              >
                <span className={ws ? "text-accent-emerald" : "text-accent-amber"}>
                  {ws ? "WS" : "WS…"}
                </span>
                <span className="text-text-muted">|</span>
                <span className={simOnline ? "text-accent-blue" : "text-text-muted"}>
                  {simOnline ? "Sim" : "Sim…"}
                </span>
              </div>
              <span className="hidden max-w-[8rem] truncate text-text-secondary lg:inline">{connection}</span>
            </>
          )}
          {smallScreen && (
            <span
              className={`h-2 w-2 rounded-full ${ws ? "bg-accent-emerald" : "bg-accent-amber"}`}
              title={ws ? "Connected" : "Disconnected"}
              aria-hidden
            />
          )}
          <ThemeToggleCompact />
          <span className="font-mono tabular-nums text-text-primary">{time}</span>
        </div>
      </div>
      {invokeError ? (
        <div className="flex items-center justify-between gap-3 border-t border-accent-red-dark/50 bg-accent-red-dark/40 px-4 py-1.5 text-xs text-accent-red-light">
          <span className="min-w-0 break-words">{invokeError}</span>
          <button
            type="button"
            className="shrink-0 rounded bg-accent-red-dark/60 px-2 py-0.5 text-xs hover:bg-accent-red"
            onClick={() => setInvokeError(null)}
          >
            ✕
          </button>
        </div>
      ) : null}
    </header>
  );
}
