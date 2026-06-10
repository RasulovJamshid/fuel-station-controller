import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Transaction } from "../types/api";

const fmtAmount = new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 0 });

function fmtTime(ms: number) {
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

// shiftId: undefined = shifts disabled (no filter), null = shift required but not started, string = filter to this shift
export function DashboardRecentTransactions({
  onOpenHistory,
  shiftId,
}: {
  onOpenHistory: () => void;
  shiftId?: string | null;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (shiftId === null) { setRows([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<Transaction[]>("get_transactions", {
        limit: 6,
        offset: 0,
        statuses: "COMPLETED,CONTINUED_FROM",
        shiftId: shiftId ?? null,
        fromMs: null,
        untilMs: null,
      });
      setRows([...list].sort((a, b) => b.started_at - a.started_at));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [shiftId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border-primary/70 bg-bg-card/70 shadow-card">
      <header className="flex items-center justify-between gap-2 border-b border-border-primary/60 bg-bg-secondary/40 px-4 py-2.5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-text-primary">{t("history.title")}</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md border border-border-primary/50 bg-bg-primary/80 px-2.5 py-1 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
          >
            {t("history.refresh")}
          </button>
          <button
            type="button"
            onClick={onOpenHistory}
            className="rounded-md bg-accent-blue px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:opacity-90"
          >
            {t("nav.history")}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden px-3 py-2">
        {shiftId === null ? (
          <p className="py-8 text-center text-sm text-text-muted">{t("history.noActiveShift")}</p>
        ) : loading && rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">{t("history.loading")}</p>
        ) : error ? (
          <p className="rounded-lg border border-accent-red/40 bg-accent-red/10 px-3 py-2 text-xs text-accent-red-light">{error}</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">{t("history.noTransactions")}</p>
        ) : (
          <div className="h-full overflow-auto rounded-lg border border-border-primary/50 bg-bg-primary/40">
            <table className="w-full border-collapse text-center text-sm text-text-primary">
              <thead className="sticky top-0 z-[1] border-b border-border-primary bg-bg-secondary/90 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2">{t("history.colNo")}</th>
                  <th className="px-3 py-2">{t("history.colDispenser")}</th>
                  <th className="px-3 py-2">{t("history.colFuel")}</th>
                  <th className="whitespace-nowrap px-3 py-2">{t("history.colLiters")}</th>
                  <th className="whitespace-nowrap px-3 py-2">{t("history.colAmount")}</th>
                  <th className="whitespace-nowrap px-3 py-2">{t("history.colDateTime")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-secondary/40">
                {rows.map((row, i) => (
                  <tr key={row.id} className="hover:bg-bg-tertiary/35 transition-colors">
                    <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-text-muted">
                      {i + 1}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-text-secondary">
                      {row.label}
                    </td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-text-secondary" title={row.product_name}>
                      {row.product_name}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs font-semibold tabular-nums text-text-primary">
                      {row.volume.toFixed(2)} L
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs tabular-nums text-text-secondary">
                      {fmtAmount.format(row.amount)} {t("history.currency")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs tabular-nums text-text-tertiary">
                      {fmtTime(row.started_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
