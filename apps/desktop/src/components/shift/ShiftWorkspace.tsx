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
  if (mode === "disabled") {
    return (
      <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-amber-800/40 bg-amber-950/20 p-8 text-center sm:p-12">
        <p className="text-slate-200">Shift tracking is off for the running service.</p>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-400">
          The API reports <code className="text-amber-200">shifts.mode = disabled</code>. Editing only{" "}
          <code className="text-slate-300">site.config.json</code> is not enough if you start the
          service with another file (for example{" "}
          <code className="text-slate-300">site.mock.json</code> via{" "}
          <code className="text-slate-300">./scripts/azs.sh dev-mock</code>).
        </p>
        <p className="mt-3 max-w-lg text-sm text-slate-500">
          Add a <code className="text-slate-400">shifts</code> block with{" "}
          <code className="text-slate-400">&quot;mode&quot;: &quot;manual&quot;</code> to the site
          file your launcher uses, then restart dispenser-service.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-slate-100">Shift management</h2>
        <p className="mt-1 text-sm text-slate-400">
          {mode === "scheduled"
            ? "Scheduled slots from site config. Start or hand over from the header when on duty."
            : "Manual shifts: start when you begin work and end or hand over from the header."}
        </p>
      </div>

      {mode === "scheduled" && schedule.length > 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Daily schedule
          </div>
          <ul className="grid gap-2 sm:grid-cols-3">
            {schedule.map((s) => (
              <li
                key={s.name}
                className="rounded-lg border border-slate-700/80 bg-slate-800/40 px-3 py-2 text-sm"
              >
                <span className="font-medium text-slate-200">{s.name}</span>
                <span className="mt-0.5 block font-mono text-xs text-slate-400">
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
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onHandover}
              className="rounded-lg border border-sky-700/50 bg-sky-950/40 px-4 py-2 text-sm font-medium text-sky-200 hover:bg-sky-900/50"
            >
              Handover
            </button>
            <button
              type="button"
              onClick={onEnd}
              className="rounded-lg border border-red-800/50 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-900/50"
            >
              End shift
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-amber-800/40 bg-amber-950/20 p-6">
          <p className="text-sm text-amber-100">No active shift.</p>
          <p className="mt-1 text-sm text-amber-200/70">
            Use <span className="font-medium">Start</span> in the header to open a shift before
            authorizing dispensers.
          </p>
          <button
            type="button"
            onClick={onStart}
            className="mt-4 rounded-lg bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600"
          >
            Start shift
          </button>
        </div>
      )}

      {recentShifts.length > 0 ? (
        <div className="min-h-0 flex-1">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Recent closed shifts
          </div>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {recentShifts.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-2 text-sm"
              >
                <span className="text-slate-200">
                  {s.operator_name}
                  {s.shift_name ? ` · ${s.shift_name}` : ""}
                </span>
                <span className="font-mono text-xs text-slate-500">
                  {s.total_transactions} tx · {s.total_volume.toFixed(1)} L
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
