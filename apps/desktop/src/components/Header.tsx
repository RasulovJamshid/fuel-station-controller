import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Settings, User } from "lucide-react";
import logoIcon from "@/assets/logo.png";
import { useAppStore } from "../store";
import { ShiftWarningBanner } from "./shift/ShiftWarningBanner";
import { ThemeToggleCompact } from "./ThemeToggle";
import type { FpState, Shift, ShiftMode } from "../types/api";
import type { WorkspaceTabId } from "./WorkspaceNav";

type HeaderShiftProps = {
  mode: ShiftMode;
  currentShift: Shift | null;
  warningMinutes: number | null;
  onStartShift: () => void;
  onEndShift: () => void;
  onHandover: () => void;
};

type HeaderProps = {
  shift: HeaderShiftProps;
  onOpenWorkspace?: (tab: WorkspaceTabId) => void;
};

export function Header({ shift, onOpenWorkspace }: HeaderProps) {
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

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const dateStr = now.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const timeStr = now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: smallScreen ? undefined : "2-digit",
  });
  const dateTime = `${dateStr} / ${timeStr}`;

  const shiftEnabled = shift.mode !== "disabled";
  const stationName = siteName && siteName !== "AZS" ? siteName : "Bo'stonliq AYOQSH";

  const brandBlock = (
    <div className="flex min-w-0 items-center gap-2 pr-2 md:pr-4 md:border-r border-border-primary/50">
      <div className={`flex shrink-0 items-center justify-center ${smallScreen ? "h-7" : "h-8"}`} aria-hidden>
        <img
          src={logoIcon}
          alt="Uzbekneftgaz"
          className="h-full w-auto object-contain drop-shadow-sm"
          draggable={false}
        />
      </div>
      <div className="min-w-0 flex flex-col justify-center leading-tight">
        <p className={`truncate font-black uppercase tracking-[0.4em] text-[#F47F1F] drop-shadow-sm ${smallScreen ? "text-[11px]" : "text-[14px]"}`}>
          UZBEKNEFTEGAZ
        </p>
        <p className={`truncate font-semibold text-[#3C82B8] ${smallScreen ? "text-[9px]" : "text-xs"}`}>
          {stationName}
        </p>
      </div>
    </div>
  );

  const connectionBadgeDesktop = (
    <div className="flex items-center gap-1.5 rounded bg-bg-secondary/40 px-1.5 py-0.5 text-[9px] font-medium border border-border-primary/30" title={connection}>
      <span className={ws ? "text-accent-emerald" : "text-accent-amber"}>{ws ? "● ON" : "○ OFF"}</span>
      {simOnline ? <span className="text-accent-blue font-bold border-l border-border-primary/40 pl-1.5">SIM</span> : null}
    </div>
  );

  const connectionBadgeMobile = (
    <span
      className={`h-1.5 w-1.5 rounded-full ${ws ? "bg-accent-emerald" : "bg-accent-amber"}`}
      title={ws ? "Connected" : "Disconnected"}
    />
  );

  const quickActions = (
    <div className="flex items-center gap-0.5 md:gap-1">
      <button
        type="button"
        title="Shift / operator"
        className="flex items-center justify-center rounded p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
        onClick={() => onOpenWorkspace?.("shift")}
      >
        <User className="h-4 w-4" />
      </button>
      <button
        type="button"
        title="Settings"
        className="flex items-center justify-center rounded p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
        onClick={() => onOpenWorkspace?.("admin")}
      >
        <Settings className="h-4 w-4" />
      </button>
      <div className="flex items-center justify-center rounded p-1">
        <ThemeToggleCompact />
      </div>
    </div>
  );

  const shiftInfo = shiftEnabled ? (
    <div className="flex items-center gap-2 rounded bg-bg-secondary/30 px-2 py-1 text-[10px] md:text-[11px] border border-border-primary/30">
      <div className="flex items-center gap-1.5 text-text-secondary">
        <User className="h-3 w-3 opacity-70" />
        {shift.currentShift ? (
          <span className="font-bold uppercase tracking-wide text-text-primary truncate max-w-[100px] md:max-w-none">
            {shift.currentShift.operator_name ?? "Operator"}
          </span>
        ) : (
          <span className="font-semibold uppercase tracking-wide text-text-tertiary">No Shift</span>
        )}
      </div>
      <div className="w-px h-3 bg-border-primary/50"></div>
      <span className="font-mono text-[9px] md:text-[10px] text-text-tertiary">
        {shift.currentShift?.shift_name ?? "——"}
      </span>
      <button
        type="button"
        className="ml-1 rounded bg-bg-tertiary/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
        onClick={() => shift.onHandover()}
      >
        Swap
      </button>
    </div>
  ) : null;

  const eStopButton = (
    <button
      type="button"
      title="Emergency stop all lanes"
      className="inline-flex items-center justify-center gap-1.5 rounded-md bg-accent-red font-bold uppercase tracking-wider text-text-inverse shadow-sm transition hover:bg-accent-red-light px-2.5 py-1 text-[10px] md:text-xs md:px-3 md:py-1.5"
      onClick={() => void onEStopAll()}
    >
      <AlertTriangle className="h-3 w-3 md:h-3.5 md:w-3.5" aria-hidden />
      <span>{smallScreen ? "Stop" : "Avariya"}</span>
    </button>
  );

  return (
    <header className="sticky top-0 z-30 shrink-0 border-b border-border-primary bg-bg-header/98 backdrop-blur-md">
      {shiftEnabled ? (
        <ShiftWarningBanner
          minutesRemaining={shift.warningMinutes}
          onHandover={shift.onHandover}
          onEndShift={shift.onEndShift}
        />
      ) : null}
      
      {smallScreen ? (
        <div className="flex flex-col gap-1 px-2 py-1">
          <div className="flex items-center justify-between gap-2">
            {brandBlock}
            <div className="flex items-center gap-1.5">
               <span className="font-mono text-[10px] tabular-nums text-text-secondary">{timeStr}</span>
               {connectionBadgeMobile}
            </div>
          </div>
          <div className="flex items-center justify-between gap-1">
            {shiftInfo}
            <div className="flex flex-1 items-center justify-end gap-1">
              {quickActions}
              <div className="ml-1">{eStopButton}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-3 flex-1">
            {brandBlock}
            {shiftInfo}
          </div>
          
          <div className="flex items-center gap-3 md:gap-4 shrink-0">
            <span className="font-mono text-xs tabular-nums tracking-tight text-text-secondary">{dateTime}</span>
            {connectionBadgeDesktop}
            <div className="flex items-center gap-1 border-l border-border-primary/50 pl-3 md:pl-4">
              {quickActions}
              <div className="ml-2">{eStopButton}</div>
            </div>
          </div>
        </div>
      )}

      {invokeError ? (
        <div className="flex items-center justify-between gap-3 border-t border-accent-red-dark/50 bg-accent-red-dark/40 px-3 py-1 text-[11px] text-accent-red-light">
          <span className="min-w-0 break-words">{invokeError}</span>
          <button
            type="button"
            className="shrink-0 rounded bg-accent-red-dark/60 px-2 py-0.5 hover:bg-accent-red transition-colors"
            onClick={() => setInvokeError(null)}
          >
            ✕
          </button>
        </div>
      ) : null}
    </header>
  );
}
