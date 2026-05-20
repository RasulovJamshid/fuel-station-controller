import type { Shift } from "../../types/api";

export function ShiftReportPanel({ shift }: { shift: Shift }) {
  const durationMs = (shift.ended_at ?? Date.now()) - shift.started_at;
  const durationHrs = (durationMs / 3_600_000).toFixed(1);
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 shadow-inner shadow-black/10">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-white">{shift.operator_name}</div>
          <div className="text-sm text-slate-400">
            {shift.shift_name ?? "Manual shift"}
            {shift.scheduled_start && shift.scheduled_end
              ? ` · ${shift.scheduled_start}–${shift.scheduled_end}`
              : ""}{" "}
            · {durationHrs}h
          </div>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase ${
            shift.status === "ACTIVE"
              ? "border-emerald-700/50 bg-emerald-950/50 text-emerald-300"
              : "border-slate-600 bg-slate-800 text-slate-400"
          }`}
        >
          {shift.status}
        </span>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="text-xs text-slate-500">Transactions</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-white">
            {shift.total_transactions}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="text-xs text-slate-500">Volume</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-white">
            {fmt.format(shift.total_volume)} L
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="text-xs text-slate-500">Revenue (minor units)</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-white">
            {(shift.total_amount / 1_000_000).toFixed(2)}M
          </div>
        </div>
      </div>

      {shift.position_totals.length > 0 ? (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Per dispenser
          </div>
          <div className="space-y-1">
            {shift.position_totals.map((pt) => (
              <div
                key={pt.fp_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-800/40 px-3 py-2"
              >
                <span className="text-sm text-slate-200">{pt.label}</span>
                <div className="flex flex-wrap gap-4 font-mono text-xs text-slate-300">
                  <span className="text-slate-500">{pt.transactions_count} fills</span>
                  <span>{fmt.format(pt.total_volume)} L</span>
                  <span>{pt.total_amount.toLocaleString()} sum</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
