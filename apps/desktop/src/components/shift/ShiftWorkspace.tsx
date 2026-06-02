import { useTranslation } from "react-i18next";
import type { Shift, ShiftMode, ShiftSlot } from "../../types/api";
import { ShiftReportPanel } from "./ShiftReportPanel";

type Props = {
  mode: ShiftMode;
  schedule: ShiftSlot[];
  currentShift: Shift | null;
  recentShifts: Shift[];
  onStart: () => void;
  onHandover: () => void;
  onEnd: () => void;
};

export function ShiftWorkspace({
  mode,
  schedule,
  currentShift,
  recentShifts,
  onStart,
  onHandover,
  onEnd,
}: Props) {
  const { t } = useTranslation();

  if (mode === "disabled") {
    return (
      <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-dashed border-accent-amber/40 bg-accent-amber/10 p-8 text-center shadow-inner sm:p-12">
        <p className="font-bold text-text-primary">{t("shiftWorkspace.disabledTitle")}</p>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-text-secondary">
          {t("shiftWorkspace.disabledDesc1")}
        </p>
        <p className="mt-3 max-w-lg text-sm text-text-tertiary">
          {t("shiftWorkspace.disabledDesc2")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto pr-2 pb-10">
      <div>
        <h2 className="text-lg font-bold text-text-primary">{t("shiftWorkspace.title")}</h2>
        <p className="mt-1 text-sm font-medium text-text-secondary">
          {mode === "scheduled"
            ? t("shiftWorkspace.scheduledDescription")
            : t("shiftWorkspace.manualDescription")}
        </p>
      </div>

      {mode === "scheduled" && schedule.length > 0 ? (
        <div className="rounded-2xl border border-border-primary/80 bg-bg-card/60 p-5 shadow-card backdrop-blur-sm">
          <div className="mb-3 text-xs font-bold uppercase tracking-wider text-text-muted">
            {t("shiftWorkspace.dailySchedule")}
          </div>
          <ul className="grid gap-2.5 sm:grid-cols-3">
            {schedule.map((s) => (
              <li
                key={s.name}
                className="rounded-xl border border-border-primary/50 bg-bg-secondary/50 px-4 py-3 text-sm transition-colors hover:bg-bg-tertiary/60 shadow-sm"
              >
                <span className="font-bold text-text-primary">{s.name}</span>
                <span className="mt-1 block font-mono text-sm font-semibold text-text-tertiary">
                  {s.start} – {s.end}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {currentShift ? (
        <div className="space-y-4">
          <ShiftReportPanel shift={currentShift} />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={onHandover}
              className="rounded-xl border border-accent-blue/40 bg-accent-blue/15 px-5 py-2.5 text-sm font-bold tracking-wide text-accent-blue shadow-button hover:bg-accent-blue/25 hover:shadow-button-hover transition-all"
            >
              {t("shiftWorkspace.handover")}
            </button>
            <button
              type="button"
              onClick={onEnd}
              className="rounded-xl border border-accent-red/40 bg-accent-red/15 px-5 py-2.5 text-sm font-bold tracking-wide text-accent-red shadow-button hover:bg-accent-red/25 hover:shadow-button-hover transition-all"
            >
              {t("shiftWorkspace.endShift")}
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-accent-amber/40 bg-accent-amber/10 p-6 shadow-inner">
          <p className="text-sm font-bold text-accent-amber-dark dark:text-accent-amber-light">
            {t("shiftWorkspace.noActiveShift")}
          </p>
          <p className="mt-1 text-sm font-medium text-accent-amber-dark/80 dark:text-accent-amber-light/80">
            {t("shiftWorkspace.useStartInHeader")}
          </p>
          <button
            type="button"
            onClick={onStart}
            className="mt-5 rounded-xl bg-accent-amber px-5 py-2.5 text-sm font-bold tracking-wide text-text-inverse shadow-button hover:brightness-110 hover:shadow-button-hover transition-all"
          >
            {t("shiftWorkspace.startShift")}
          </button>
        </div>
      )}

      {recentShifts.length > 0 ? (
        <div className="min-h-0 shrink-0">
          <div className="mb-4 text-xs font-bold uppercase tracking-widest text-text-muted">
            {t("shiftWorkspace.closedShifts")}
          </div>
          <div className="space-y-6">
            {recentShifts.map((s) => (
              <ShiftReportPanel key={s.id} shift={s} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
