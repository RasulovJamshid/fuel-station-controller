import { useEffect, useState } from "react";
import type { Shift, Transaction } from "../../types/api";

const fmtL = new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 1 });
const fmtSum = new Intl.NumberFormat("uz-UZ");

export function ShiftReportPanel({ shift }: { shift: Shift }) {
  const durationMs = (shift.ended_at ?? Date.now()) - shift.started_at;
  const durationHrs = (durationMs / 3_600_000).toFixed(1);
  const startStr = new Date(shift.started_at).toLocaleString("uz-UZ");
  const endStr = shift.ended_at ? new Date(shift.ended_at).toLocaleString("uz-UZ") : "Hozirgacha";

  const [productTotals, setProductTotals] = useState<{name: string; volume: number; amount: number; count: number}[] | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        // Fetch recent transactions to compute product breakdown
        const list = await invoke<Transaction[]>("get_transactions", { limit: 3000, offset: 0 });
        const shiftTxs = list.filter(t => t.shift_id === shift.id && t.status === "COMPLETED");
        
        if (shiftTxs.length > 0) {
          const map = new Map<string, {name: string, volume: number, amount: number, count: number}>();
          for (const t of shiftTxs) {
            const existing = map.get(t.product_name) || { name: t.product_name, volume: 0, amount: 0, count: 0 };
            existing.volume += t.volume;
            existing.amount += t.amount;
            existing.count += 1;
            map.set(t.product_name, existing);
          }
          setProductTotals(Array.from(map.values()).sort((a,b) => a.name.localeCompare(b.name)));
        } else {
          setProductTotals([]); // No transactions found in limit
        }
      } catch (e) {
        console.error("Failed to load transactions for product totals:", e);
      }
    }
    load();
  }, [shift.id]);

  return (
    <div className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-5 shadow-card backdrop-blur-sm print:shadow-none print:border-none print:bg-white print:text-black">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-lg font-bold text-text-primary print:text-black">{shift.operator_name}</div>
          <div className="text-sm font-medium text-text-secondary print:text-gray-700">
            {shift.shift_name ?? "Smena"}
            {shift.scheduled_start && shift.scheduled_end
              ? ` · ${shift.scheduled_start}–${shift.scheduled_end}`
              : ""}{" "}
            · {durationHrs} soat
          </div>
          <div className="mt-1 text-xs text-text-muted print:text-gray-500">
            {startStr} — {endStr}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg border border-border-primary bg-bg-secondary px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-tertiary print:hidden"
          >
            Chop etish
          </button>
          <span
            className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
              shift.status === "ACTIVE"
                ? "border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald"
                : "border-border-secondary bg-bg-secondary text-text-secondary"
            }`}
          >
            {shift.status}
          </span>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border-primary/60 bg-bg-secondary/60 p-4 transition-colors hover:bg-bg-tertiary/60 print:border-gray-300 print:bg-transparent">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary print:text-gray-600">Tranzaksiyalar</div>
          <div className="mt-1 font-mono text-2xl font-bold text-text-primary print:text-black">
            {shift.total_transactions}
          </div>
        </div>
        <div className="rounded-xl border border-border-primary/60 bg-bg-secondary/60 p-4 transition-colors hover:bg-bg-tertiary/60 print:border-gray-300 print:bg-transparent">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary print:text-gray-600">Hajm</div>
          <div className="mt-1 font-mono text-2xl font-bold text-text-primary print:text-black">
            {fmtL.format(shift.total_volume)} L
          </div>
        </div>
        <div className="rounded-xl border border-border-primary/60 bg-bg-secondary/60 p-4 transition-colors hover:bg-bg-tertiary/60 print:border-gray-300 print:bg-transparent">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary print:text-gray-600">Tushum</div>
          <div className="mt-1 font-mono text-2xl font-bold text-text-primary print:text-black">
            {fmtSum.format(shift.total_amount)} so'm
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {shift.position_totals.length > 0 ? (
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-text-muted print:text-gray-600">
              Kolonkalar bo'yicha
            </div>
            <div className="space-y-1.5">
              {shift.position_totals.map((pt) => (
                <div
                  key={pt.fp_id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-primary/30 bg-bg-tertiary/40 px-3 py-2.5 transition-colors hover:bg-bg-tertiary/70 print:border-gray-300 print:bg-transparent"
                >
                  <span className="text-sm font-semibold text-text-primary print:text-black">{pt.label}</span>
                  <div className="flex flex-wrap gap-4 font-mono text-xs font-medium text-text-tertiary print:text-gray-700">
                    <span className="text-text-muted">{pt.transactions_count} ta</span>
                    <span className="text-accent-blue">{fmtL.format(pt.total_volume)} L</span>
                    <span className="text-text-secondary">{fmtSum.format(pt.total_amount)} so'm</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {productTotals && productTotals.length > 0 ? (
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-text-muted print:text-gray-600">
              Yoqilg'i turlari bo'yicha
            </div>
            <div className="space-y-1.5">
              {productTotals.map((pt) => (
                <div
                  key={pt.name}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-primary/30 bg-bg-tertiary/40 px-3 py-2.5 transition-colors hover:bg-bg-tertiary/70 print:border-gray-300 print:bg-transparent"
                >
                  <span className="text-sm font-semibold text-text-primary print:text-black">{pt.name}</span>
                  <div className="flex flex-wrap gap-4 font-mono text-xs font-medium text-text-tertiary print:text-gray-700">
                    <span className="text-text-muted">{pt.count} ta</span>
                    <span className="text-accent-emerald">{fmtL.format(pt.volume)} L</span>
                    <span className="text-accent-amber">{fmtSum.format(pt.amount)} so'm</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
