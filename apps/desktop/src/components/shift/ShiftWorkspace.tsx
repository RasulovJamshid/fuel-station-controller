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
          { statuses: "COMPLETED,STOPPED,CONTINUED_FROM", fromMs: startOfDay.getTime() },
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
  const [expandedShiftId, setExpandedShiftId] = useState<string | null>(null);

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
      <div className="flex h-full flex-col items-center justify-center rounded-lg border border-border-primary bg-bg-card p-8 text-center sm:p-12">
        <p className="font-semibold text-text-primary">{t("shiftWorkspace.disabledTitle")}</p>
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
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pb-6 pr-1">
      <div>
        <h2 className="text-base font-semibold text-text-primary">{t("shiftWorkspace.title")}</h2>
        <p className="mt-0.5 text-sm text-text-secondary">
          {mode === "scheduled"
            ? t("shiftWorkspace.scheduledDescription")
            : t("shiftWorkspace.manualDescription")}
        </p>
      </div>

      {mode === "scheduled" && schedule.length > 0 ? (
        <div className="rounded-lg border border-border-primary/70 bg-bg-card p-3">
          <div className="mb-2 text-xs font-semibold text-text-muted">
            {t("shiftWorkspace.dailySchedule")}
          </div>
          <ul className="grid divide-y divide-border-primary/50 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {schedule.map((s) => (
              <li
                key={s.name}
                className="px-3 py-2 text-sm first:pl-1 last:pr-1"
              >
                <span className="font-medium text-text-primary">{s.name}</span>
                <span className="mt-0.5 block font-mono text-xs text-text-tertiary">
                  {s.start} – {s.end}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {todayStats && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-border-primary/60 bg-bg-secondary/30 px-3 py-2">
          <span className="text-xs font-medium text-text-muted">
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
        <div className="space-y-2">
          <ShiftReportPanel shift={currentShift} onViewTransactions={onViewShiftTransactions} />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={onHandover}
              className="rounded border border-accent-blue/60 bg-accent-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-110"
            >
              {t("shiftWorkspace.handover")}
            </button>
            <button
              type="button"
              onClick={onEnd}
              className="rounded border border-accent-red/50 bg-transparent px-4 py-2 text-sm font-medium text-accent-red transition-colors hover:bg-accent-red/10"
            >
              {t("shiftWorkspace.endShift")}
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border-primary bg-bg-card p-4 border-l-2 border-l-accent-amber">
          <p className="text-sm font-semibold text-text-primary">
            {t("shiftWorkspace.noActiveShift")}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            {t("shiftWorkspace.useStartInHeader")}
          </p>
          <button
            type="button"
            onClick={onStart}
            className="mt-4 rounded border border-accent-emerald/60 bg-accent-emerald px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-110"
          >
            {t("shiftWorkspace.startShift")}
          </button>
        </div>
      )}

      {/* ── Closed shifts ── */}
      {recentShifts.length > 0 ? (
        <div className="min-h-0 shrink-0 overflow-hidden rounded-lg border border-border-primary/70 bg-bg-card">
          {/* Header + controls */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border-primary/60 bg-bg-secondary/30 px-3 py-2">
            <span className="text-xs font-semibold text-text-secondary">
              {t("shiftWorkspace.closedShifts")}
            </span>
            <span className="border-l border-border-primary pl-2 text-[10px] font-medium text-text-muted">
              {filtered.length}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder={t("shiftWorkspace.searchPlaceholder")}
                className="w-40 rounded border border-border-primary/60 bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus sm:w-52"
              />
              <button
                type="button"
                onClick={toggleSort}
                className="whitespace-nowrap rounded border border-border-primary/60 bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
              >
                {sortAsc ? t("shiftWorkspace.sortOldest") : t("shiftWorkspace.sortNewest")}
              </button>
            </div>
          </div>

          {/* Shift list */}
          {paged.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-text-muted">
              {t("shiftWorkspace.noShiftsFound")}
            </p>
          ) : (
            <div className="divide-y divide-border-primary/60">
              {paged.map((s) => (
                <ShiftReportPanel
                  key={s.id}
                  shift={s}
                  onViewTransactions={onViewShiftTransactions}
                  compact={expandedShiftId !== s.id}
                  onToggleDetails={() => setExpandedShiftId((id) => id === s.id ? null : s.id)}
                />
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 border-t border-border-primary/60 bg-bg-secondary/20 px-3 py-2">
              <button
                type="button"
                disabled={safePage === 0}
                onClick={() => setPage((p) => p - 1)}
                className="rounded border border-border-primary/60 bg-bg-primary px-3 py-1 text-sm text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
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
                className="rounded border border-border-primary/60 bg-bg-primary px-3 py-1 text-sm text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
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
