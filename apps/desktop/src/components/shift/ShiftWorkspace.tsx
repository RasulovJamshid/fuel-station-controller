import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Shift, ShiftMode, ShiftSlot } from "../../types/api";
import { ShiftReportPanel } from "./ShiftReportPanel";

const PAGE_SIZE = 8;
const fmtL   = new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 1 });
const fmtSum = new Intl.NumberFormat("uz-UZ");

type Props = {
  mode: ShiftMode;
  schedule: ShiftSlot[];
  currentShift: Shift | null;
  recentShifts: Shift[];
  onStart: () => void;
  onHandover: () => void;
  onEnd: () => void;
  onViewShiftTransactions?: (shiftId: string) => void;
};

export function ShiftWorkspace({
  mode,
  schedule,
  currentShift,
  recentShifts,
  onStart,
  onHandover,
  onEnd,
  onViewShiftTransactions,
}: Props) {
  const { t } = useTranslation();

  const [todayStats, setTodayStats] = useState<{ count: number; volume: number; amount: number } | null>(null);
  useEffect(() => {
    if (mode === "disabled") return;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const load = () =>
      import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke<{ count: number; total_volume: number; total_amount: number }>(
          "get_transactions_summary",
          { statuses: "COMPLETED,CONTINUED_FROM", fromMs: startOfDay.getTime() },
        ).then((s) => setTodayStats({ count: s.count, volume: s.total_volume, amount: s.total_amount }))
          .catch(() => {})
      );
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(id);
  }, [mode]);

  const [search, setSearch]     = useState("");
  const [sortAsc, setSortAsc]   = useState(false);
  const [page, setPage]         = useState(0);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? recentShifts.filter(
          (s) =>
            s.operator_name.toLowerCase().includes(q) ||
            (s.shift_name ?? "").toLowerCase().includes(q),
        )
      : recentShifts;
    return [...list].sort((a, b) =>
      sortAsc ? a.started_at - b.started_at : b.started_at - a.started_at,
    );
  }, [recentShifts, search, sortAsc]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages - 1);
  const paged      = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const handleSearch = (v: string) => { setSearch(v); setPage(0); };
  const toggleSort   = () => { setSortAsc((v) => !v); setPage(0); };

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

      {todayStats && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border-primary/50 bg-bg-secondary/50 px-4 py-2.5 shadow-sm">
          <span className="text-xs font-bold uppercase tracking-widest text-text-muted">
            {t("shiftWorkspace.todayTotals")}
          </span>
          <span className="font-mono text-sm font-semibold text-text-primary">
            {todayStats.count} {t("shiftReport.countSuffix")}
          </span>
          <span className="font-mono text-sm font-semibold text-accent-blue">
            {fmtL.format(todayStats.volume)} L
          </span>
          <span className="font-mono text-sm font-semibold text-accent-amber">
            {fmtSum.format(todayStats.amount)} {t("shiftReport.currency")}
          </span>
        </div>
      )}

      {currentShift ? (
        <div className="space-y-4">
          <ShiftReportPanel shift={currentShift} onViewTransactions={onViewShiftTransactions} />
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

      {/* ── Closed shifts ── */}
      {recentShifts.length > 0 ? (
        <div className="min-h-0 shrink-0 space-y-4">
          {/* Header + controls */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-widest text-text-muted">
              {t("shiftWorkspace.closedShifts")}
            </span>
            <span className="rounded-full border border-border-primary/50 bg-bg-secondary/60 px-2 py-0.5 text-[10px] font-semibold text-text-muted">
              {filtered.length}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder={t("shiftWorkspace.searchPlaceholder")}
                className="w-40 rounded-lg border border-border-primary/60 bg-bg-secondary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus sm:w-52"
              />
              <button
                type="button"
                onClick={toggleSort}
                className="rounded-lg border border-border-primary/60 bg-bg-secondary px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors whitespace-nowrap"
              >
                {sortAsc ? t("shiftWorkspace.sortOldest") : t("shiftWorkspace.sortNewest")}
              </button>
            </div>
          </div>

          {/* Shift list */}
          {paged.length === 0 ? (
            <p className="rounded-xl border border-border-primary/40 bg-bg-secondary/40 px-4 py-6 text-center text-sm text-text-muted">
              {t("shiftWorkspace.noShiftsFound")}
            </p>
          ) : (
            <div className="space-y-4">
              {paged.map((s) => (
                <ShiftReportPanel key={s.id} shift={s} onViewTransactions={onViewShiftTransactions} />
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-1">
              <button
                type="button"
                disabled={safePage === 0}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-lg border border-border-primary/60 bg-bg-secondary px-3.5 py-1.5 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                ←
              </button>
              <span className="min-w-[4rem] text-center text-xs font-semibold text-text-muted">
                {t("shiftWorkspace.pageOf", { current: safePage + 1, total: totalPages })}
              </span>
              <button
                type="button"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-border-primary/60 bg-bg-secondary px-3.5 py-1.5 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                →
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
