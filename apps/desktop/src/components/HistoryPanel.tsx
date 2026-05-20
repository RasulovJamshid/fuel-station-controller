import { useCallback, useEffect, useState } from "react";
import type { Transaction, TxStatus } from "../types/api";
import { txStatusLabel, txStatusParentId } from "../types/api";

const fmtTime = (ms: number) => {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "—";
  }
};

const fmtInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function statusPill(s: TxStatus) {
  const base =
    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide";
  switch (txStatusLabel(s)) {
    case "COMPLETED":
      return `${base} bg-emerald-950/70 text-emerald-300 ring-1 ring-emerald-700/40`;
    case "ABORTED":
      return `${base} bg-amber-950/70 text-amber-200 ring-1 ring-amber-700/40`;
    case "STOPPED":
      return `${base} bg-red-950/70 text-red-200 ring-1 ring-red-700/40`;
    case "CONTINUED_FROM":
      return `${base} bg-sky-950/70 text-sky-200 ring-1 ring-sky-700/40`;
    default:
      return `${base} bg-slate-800 text-slate-300`;
  }
}

export function HistoryPanel(props: { visible: boolean }) {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<Transaction[]>("get_transactions", {
        limit: 200,
        offset: 0,
      });
      setRows(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!props.visible) return;
    void load();
  }, [props.visible, load]);

  if (!props.visible) return null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Transaction history</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Latest records from the service database (newest first).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300 ring-1 ring-slate-700/80">
            {rows.length} loaded
          </span>
          <button
            type="button"
            disabled={loading}
            className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-100 hover:bg-slate-700 disabled:opacity-50"
            onClick={() => void load()}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {err ? (
        <div className="shrink-0 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-200">
          {err}
        </div>
      ) : null}

      {loading && rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-12 text-slate-400">
          Loading transactions…
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-12 text-center">
          <p className="text-slate-300">No transactions yet.</p>
          <p className="max-w-sm text-sm text-slate-500">Completed deliveries and stops will appear here.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40 shadow-inner shadow-black/20">
          <div className="h-full overflow-auto overscroll-contain">
            <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-[1] border-b border-slate-800 bg-slate-900/98 text-xs font-semibold uppercase tracking-wide text-slate-400 shadow-sm backdrop-blur">
                <tr>
                  <th className="whitespace-nowrap px-3 py-3 pl-4">Started</th>
                  <th className="px-3 py-3">Lane</th>
                  <th className="px-3 py-3">Product</th>
                  <th className="px-3 py-3">Nozzle</th>
                  <th className="whitespace-nowrap px-3 py-3 text-right">Volume (L)</th>
                  <th className="whitespace-nowrap px-3 py-3 text-right">Amount</th>
                  <th className="whitespace-nowrap px-3 py-3 text-right">Price / L</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="min-w-[6rem] px-3 py-3 pr-4 font-mono font-normal normal-case tracking-normal text-slate-500">
                    Id
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-slate-200">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-800/35">
                    <td className="whitespace-nowrap px-3 py-2.5 pl-4 font-mono text-xs text-slate-300">
                      {fmtTime(r.started_at)}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-medium text-slate-100" title={r.fp_id}>
                        {r.label || r.fp_id}
                      </span>
                    </td>
                    <td className="max-w-[14rem] px-3 py-2.5 text-slate-200" title={r.product_name}>
                      <span className="line-clamp-2">{r.product_name}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs tabular-nums text-slate-400">
                      {r.nozzle_index}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs tabular-nums">
                      {r.volume.toFixed(3)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs tabular-nums text-slate-300">
                      {fmtInt.format(r.amount)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs tabular-nums text-slate-400">
                      {r.price}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={statusPill(r.status)}
                        title={txStatusParentId(r.status) ?? undefined}
                      >
                        {txStatusLabel(r.status)}
                      </span>
                    </td>
                    <td
                      className="max-w-[7rem] truncate px-3 py-2.5 pr-4 font-mono text-[11px] text-slate-500"
                      title={r.id}
                    >
                      {r.id}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
