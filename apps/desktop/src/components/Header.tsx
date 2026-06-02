import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import logoIcon from "@/assets/logo.png";
import { useAppStore } from "../store";
import { ShiftWarningBanner } from "./shift/ShiftWarningBanner";
import { statusTag } from "../types/api";
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
  const { t } = useTranslation();
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
      const currentStates = useAppStore.getState().states;
      const wasActive = new Set(
        currentStates
          .filter((s) => { const t = statusTag(s.status); return t === "DELIVERING" || t === "AUTHORIZING"; })
          .map((s) => s.fp_id),
      );
      await invoke("emergency_stop_all");
      // Poll until all previously-delivering lanes have left DELIVERING/AUTHORIZING.
      const deadline = Date.now() + 3000;
      let rows: FpState[] = [];
      while (Date.now() < deadline) {
        rows = await invoke<FpState[]>("get_all_status");
        const stillActive = rows.some((s) => {
          if (!wasActive.has(s.fp_id)) return false;
          const t = statusTag(s.status);
          return t === "DELIVERING" || t === "AUTHORIZING";
        });
        if (!stillActive) break;
        await new Promise<void>((r) => window.setTimeout(r, 200));
      }
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
    <div className="flex min-w-0 items-center gap-3 pr-3 md:pr-5 md:border-r border-border-primary/50">
      <div className={`flex shrink-0 items-center justify-center ${smallScreen ? "h-10" : "h-10"}`} aria-hidden>
        <img
          src={logoIcon}
          alt="Uzbekneftgaz"
          className="h-full w-auto object-contain drop-shadow-sm animate-logo-spin-y"
          draggable={false}
        />
      </div>
      <div className="min-w-0 flex flex-col justify-center leading-tight gap-px">
        <p className={`truncate font-black uppercase tracking-[0.35em] text-[#F47F1F] drop-shadow-sm ${smallScreen ? "text-[16px]" : "text-[17px]"}`}>
          UZBEKNEFTEGAZ
        </p>
        <p className={`truncate font-semibold text-[#3C82B8] ${smallScreen ? "text-[12px]" : "text-[13px]"}`}>
          {stationName}
        </p>
      </div>
    </div>
  );

  const connectionBadgeDesktop = (
    <div className="flex items-center gap-1.5 rounded bg-bg-secondary/40 px-1.5 py-0.5 text-[9px] font-medium border border-border-primary/30" title={connection}>
      <span className={ws ? "text-accent-emerald" : "text-accent-amber"} title={ws ? t("header.connected") : t("header.disconnected")}>{ws ? `● ${t("header.wsOn")}` : `○ ${t("header.wsOff")}`}</span>
      {simOnline ? <span className="text-accent-blue font-bold border-l border-border-primary/40 pl-1.5">SIM</span> : null}
    </div>
  );

  const connectionBadgeMobile = (
    <span
      className={`h-2.5 w-2.5 rounded-full ${ws ? "bg-accent-emerald" : "bg-accent-amber"}`}
      title={ws ? t("header.connected") : t("header.disconnected")}
    />
  );

const shiftInfo = shiftEnabled ? (
    <div className="flex items-center gap-2 rounded bg-bg-secondary/30 border border-border-primary/30 px-2.5 py-1.5 text-xs">
      <div className="flex items-center gap-1.5 text-text-secondary">
        <User className="h-4 w-4 opacity-70" />
        {shift.currentShift ? (
          <span className="font-bold uppercase tracking-wide text-text-primary truncate max-w-[90px] sm:max-w-none">
            {shift.currentShift.operator_name ?? t("header.operatorFallback")}
          </span>
        ) : (
          <span className="font-semibold uppercase tracking-wide text-text-tertiary">{t("header.noShift")}</span>
        )}
      </div>
      <div className="w-px h-3 bg-border-primary/50" />
      <span className="font-mono text-[11px] text-text-tertiary">
        {shift.currentShift?.shift_name ?? "——"}
      </span>
      <button
        type="button"
        className="ml-1 rounded bg-bg-tertiary/50 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
        onClick={() => shift.onHandover()}
      >
        {t("header.swap")}
      </button>
    </div>
  ) : null;

  const eStopButton = (
    <button
      type="button"
      title={t("header.emergencyTitle")}
      className="inline-flex items-center justify-center gap-1.5 rounded-md bg-accent-red px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-text-inverse shadow-sm transition hover:bg-accent-red-light"
      onClick={() => void onEStopAll()}
    >
      <AlertTriangle className="h-4 w-4" aria-hidden />
      <span>{t("header.emergencyShort")}</span>
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
      
      <div className="flex items-center gap-2 px-3 py-1.5">
        {brandBlock}
        <div className="min-w-0 flex-1">{shiftInfo}</div>
        <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums text-text-secondary">
          {smallScreen ? timeStr : dateTime}
        </span>
        {connectionBadgeMobile}
        {eStopButton}
      </div>

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
