import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Shift, Transaction } from "../../types/api";
import { printHtmlDocument } from "../../lib/printDocument";

const fmtL = new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 1 });
const fmtSum = new Intl.NumberFormat("uz-UZ");
const SHIFT_PRINT_ROOT_ID = "azs-shift-print-root";
const SHIFT_PRINT_STYLE_ID = "azs-shift-print-style";

const SHIFT_PRINT_CSS = `
  #${SHIFT_PRINT_ROOT_ID} { display: none; }
  @media print {
    html, body {
      height: auto !important;
      overflow: visible !important;
      background: #fff !important;
    }
    body > *:not(#${SHIFT_PRINT_ROOT_ID}) { display: none !important; }
    #${SHIFT_PRINT_ROOT_ID} {
      display: block !important;
      position: static;
      width: 100%;
      min-height: 0;
      background: #fff;
      padding: 12mm 10mm;
      font-family: Arial, sans-serif;
      font-size: 11px;
      color: #111;
    }
  }
`;

const SHIFT_INNER_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .sh { margin-bottom: 14px; border-bottom: 2px solid #bbb; padding-bottom: 10px; }
  .sh h1 { font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .sh .sub { font-size: 10px; color: #555; margin-top: 3px; }
  .sh .dates { font-size: 10px; color: #888; margin-top: 2px; }
  .stats { display: flex; gap: 10px; margin-bottom: 14px; }
  .stats .s { border: 1px solid #ddd; border-radius: 5px; padding: 7px 12px; flex: 1; }
  .stats .s .l { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #888; margin-bottom: 2px; }
  .stats .s .v { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .section { margin-bottom: 12px; }
  .section h2 { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #888; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; }
  thead tr { background: #f0f0f0; }
  th { padding: 4px 8px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #555; border-bottom: 2px solid #bbb; white-space: nowrap; }
  td { padding: 3px 8px; border-bottom: 1px solid #eee; font-size: 10.5px; }
  .alt td { background: #fafafa; }
  .r { text-align: right; }
  .m { font-family: 'Courier New', monospace; }
  .notes-box { border: 1px solid #ddd; border-radius: 4px; padding: 6px 10px; font-size: 10px; color: #444; }
  .notes-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #888; margin-bottom: 3px; }
  .foot { margin-top: 12px; font-size: 9px; color: #bbb; text-align: right; border-top: 1px solid #eee; padding-top: 6px; }
`;

type ProductTotal = { name: string; volume: number; amount: number; count: number };

function buildShiftPrintHtml(
  shift: Shift,
  productTotals: ProductTotal[] | null,
  t: (key: string) => string,
): string {
  const fmtV = (v: number) => v.toFixed(2);
  const fmtA = (a: number) => new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 0 }).format(a);
  const durationHrs = ((( shift.ended_at ?? Date.now()) - shift.started_at) / 3_600_000).toFixed(1);
  const startStr = new Date(shift.started_at).toLocaleString(undefined, {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const endStr = shift.ended_at
    ? new Date(shift.ended_at).toLocaleString(undefined, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : t("shiftReport.untilNow");
  const now = new Date().toLocaleString(undefined, {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const cu = t("shiftReport.currency");
  const suffix = t("shiftReport.countSuffix");

  const byDispenserHtml = shift.position_totals.length > 0 ? `
    <div class="section">
      <h2>${t("shiftReport.byDispenser")}</h2>
      <table>
        <thead><tr>
          <th>${t("shiftReport.dispenserLabel") || "Kolonka"}</th>
          <th class="r">${t("shiftReport.transactions")}</th>
          <th class="r">${t("shiftReport.volume")}</th>
          <th class="r">${t("shiftReport.revenue")}</th>
        </tr></thead>
        <tbody>
          ${shift.position_totals.map((pt, i) => `
            <tr class="${i % 2 === 1 ? "alt" : ""}">
              <td>${pt.label || pt.fp_id}</td>
              <td class="r m">${pt.transactions_count} ${suffix}</td>
              <td class="r m">${fmtV(pt.total_volume)} L</td>
              <td class="r m">${fmtA(pt.total_amount)} ${cu}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>` : "";

  const byFuelHtml = productTotals && productTotals.length > 0 ? `
    <div class="section">
      <h2>${t("shiftReport.byFuelType")}</h2>
      <table>
        <thead><tr>
          <th>${t("shiftReport.fuelLabel") || "Yoqilg'i"}</th>
          <th class="r">${t("shiftReport.transactions")}</th>
          <th class="r">${t("shiftReport.volume")}</th>
          <th class="r">${t("shiftReport.revenue")}</th>
        </tr></thead>
        <tbody>
          ${productTotals.map((pt, i) => `
            <tr class="${i % 2 === 1 ? "alt" : ""}">
              <td>${pt.name}</td>
              <td class="r m">${pt.count} ${suffix}</td>
              <td class="r m">${fmtV(pt.volume)} L</td>
              <td class="r m">${fmtA(pt.amount)} ${cu}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>` : "";

  const notesHtml = shift.notes ? `
    <div class="section">
      <div class="notes-label">${t("shiftReport.notes")}</div>
      <div class="notes-box">${shift.notes}</div>
    </div>` : "";

  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
  const metersHtml = shift.nozzle_totalizers?.length ? `
    <div class="section">
      <h2>${t("shiftReport.meterReadings")} (L)</h2>
      <table><thead><tr>
        <th>${t("shiftReport.nozzle")}</th>
        <th class="r">${t("shiftReport.meterOpen")}</th>
        <th class="r">${t(shift.status === "ACTIVE" ? "shiftReport.meterCurrent" : "shiftReport.meterClose")}</th>
        <th class="r">${t("shiftReport.meterChange")}</th>
        <th class="r">${t("shiftReport.recorded")}</th>
        <th class="r">${t("shiftReport.variance")}</th>
      </tr></thead><tbody>${shift.nozzle_totalizers.map(meter => `<tr>
        <td>${escape(meter.label || meter.fp_id)} · ${meter.nozzle_index} · ${escape(meter.product_name)}</td>
        ${[meter.open_volume, shift.status === "ACTIVE" ? meter.current_volume : meter.close_volume, meter.dispensed_volume, meter.recorded_volume, meter.variance_volume].map(value => `<td class="r m">${value == null ? '—' : fmtV(value)}</td>`).join('')}
      </tr>`).join('')}</tbody></table>
      <p>${t(shift.status === "ACTIVE" ? "shiftReport.meterLiveHint" : "shiftReport.meterHint")}</p>
    </div>` : '';

  return `
    <style>${SHIFT_INNER_CSS}</style>
    <div class="sh">
      <h1>${shift.operator_name}</h1>
      <div class="sub">${shift.shift_name ?? t("shiftReport.shiftFallback")}${
        shift.scheduled_start && shift.scheduled_end
          ? ` · ${shift.scheduled_start}–${shift.scheduled_end}`
          : ""
      } · ${durationHrs} ${t("shiftReport.hours")}</div>
      <div class="dates">${startStr} — ${endStr}</div>
    </div>
    <div class="stats">
      <div class="s"><div class="l">${t("shiftReport.transactions")}</div><div class="v">${shift.total_transactions} ${suffix}</div></div>
      <div class="s"><div class="l">${t("shiftReport.volume")}</div><div class="v m">${fmtV(shift.total_volume)} L</div></div>
      <div class="s"><div class="l">${t("shiftReport.revenue")}</div><div class="v m">${fmtA(shift.total_amount)} ${cu}</div></div>
    </div>
    ${byDispenserHtml}
    ${byFuelHtml}
    ${metersHtml}
    ${notesHtml}
    <div class="foot">${t("shiftReport.printedAt") || "Chop etildi"}: ${now}</div>
  `;
}

export function ShiftReportPanel({
  shift: summaryShift,
  onViewTransactions,
  compact = false,
  onToggleDetails,
}: {
  shift: Shift;
  onViewTransactions?: (shiftId: string) => void;
  compact?: boolean;
  onToggleDetails?: () => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<Shift | null>(null);
  const [reportError, setReportError] = useState(false);
  const [printing, setPrinting] = useState(false);
  const shift = detail?.id === summaryShift.id && detail.status === summaryShift.status ? detail : summaryShift;

  useEffect(() => {
    if (compact) return;
    let cancelled = false;
    let pending = false;
    let loaded = false;
    const load = async () => {
      if (pending || (loaded && summaryShift.status === "CLOSED")) return;
      pending = true;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const report = await invoke<Shift>("get_shift_report", { id: summaryShift.id });
        if (!cancelled) { setDetail(report); setReportError(false); loaded = true; }
      } catch {
        if (!cancelled) setReportError(true);
      } finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [summaryShift.id, summaryShift.status, compact]);
  const durationMs = (shift.ended_at ?? Date.now()) - shift.started_at;
  const durationHrs = (durationMs / 3_600_000).toFixed(1);
  const startStr = new Date(shift.started_at).toLocaleString("uz-UZ");
  const endStr = shift.ended_at ? new Date(shift.ended_at).toLocaleString("uz-UZ") : t("shiftReport.untilNow");

  const [productTotals, setProductTotals] = useState<{name: string; volume: number; amount: number; count: number}[] | null>(null);

  useEffect(() => {
    // The service now computes the grade breakdown for every shift, open or
    // closed. Only fall back to aggregating transactions client-side when
    // talking to a service that predates `product_totals`.
    if (shift.product_totals && shift.product_totals.length > 0) {
      setProductTotals(
        shift.product_totals.map((pt) => ({
          name: pt.product_name,
          volume: pt.total_volume,
          amount: pt.total_amount,
          count: pt.transactions_count,
        })),
      );
      return;
    }
    if (shift.status !== "ACTIVE") {
      setProductTotals([]);
      return;
    }
    async function load() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const list = await invoke<Transaction[]>("get_transactions", {
          shiftId: shift.id,
          statuses: "COMPLETED,STOPPED,CONTINUED_FROM",
          limit: 2000,
          offset: 0,
        });
        if (list.length > 0) {
          const map = new Map<string, {name: string, volume: number, amount: number, count: number}>();
          for (const tx of list) {
            const existing = map.get(tx.product_name) || { name: tx.product_name, volume: 0, amount: 0, count: 0 };
            const isContinuation =
              typeof tx.status === "object" && tx.status !== null && "CONTINUED_FROM" in tx.status;
            existing.volume += isContinuation
              ? tx.volume
              : ((tx.combined_volume ?? 0) > 0 ? tx.combined_volume! : tx.volume);
            existing.amount += isContinuation
              ? tx.amount
              : ((tx.combined_amount ?? 0) > 0 ? tx.combined_amount! : tx.amount);
            existing.count += 1;
            map.set(tx.product_name, existing);
          }
          setProductTotals(Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name)));
        } else {
          setProductTotals([]);
        }
      } catch (e) {
        console.error("Failed to load transactions for product totals:", e);
      }
    }
    load();
  }, [shift.id, shift.status, shift.product_totals]);

  const handlePrint = useCallback(async () => {
    setPrinting(true);
    try {
      // List rows omit meters: printing must fetch the full saved report too.
      const { invoke } = await import("@tauri-apps/api/core");
      const report = await invoke<Shift>("get_shift_report", { id: shift.id });
      setDetail(report);
      setReportError(false);
      await printHtmlDocument({
        rootId: SHIFT_PRINT_ROOT_ID,
        styleId: SHIFT_PRINT_STYLE_ID,
        html: buildShiftPrintHtml(report, report.product_totals?.map(pt => ({ name: pt.product_name, volume: pt.total_volume, amount: pt.total_amount, count: pt.transactions_count })) ?? productTotals, t),
        css: SHIFT_PRINT_CSS,
      });
    } catch { setReportError(true); }
    finally { setPrinting(false); }
  }, [shift.id, productTotals, t]);

  return (
    <div className={`overflow-hidden bg-bg-card ${onToggleDetails ? "" : "rounded-lg border border-border-primary/70"}`}>
      <div className={`flex flex-wrap items-start justify-between gap-3 px-3 ${compact ? "py-2.5" : "border-b border-border-primary/60 py-3"}`}>
        <div className="min-w-0">
          <div className={`${compact ? "text-sm" : "text-base"} truncate font-semibold text-text-primary`}>{shift.operator_name}</div>
          <div className="mt-0.5 text-xs text-text-secondary">
            {shift.shift_name ?? t("shiftReport.shiftFallback")}
            {shift.scheduled_start && shift.scheduled_end
              ? ` · ${shift.scheduled_start}–${shift.scheduled_end}`
              : ""}{" "}
            · {durationHrs} {t("shiftReport.hours")}
          </div>
          <div className="mt-0.5 text-xs text-text-muted">
            {startStr} — {endStr}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void handlePrint()}
            disabled={printing}
            className="rounded border border-border-primary/60 bg-bg-primary px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
          >
            {t("shiftReport.print")}
          </button>
          <span
            className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] font-medium ${
              shift.status === "ACTIVE"
                ? "border-accent-emerald/45 text-accent-emerald"
                : "border-border-primary text-text-secondary"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${shift.status === "ACTIVE" ? "bg-accent-emerald" : "bg-text-muted"}`} />
            {t(`shiftStatus.${shift.status}`)}
          </span>
          {onToggleDetails ? (
            <button
              type="button"
              onClick={onToggleDetails}
              aria-expanded={!compact}
              className="rounded border border-border-primary/60 bg-bg-primary px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
            >
              {compact ? t("shiftReport.showDetails") : t("shiftReport.hideDetails")}
              <span className="ml-1.5" aria-hidden="true">{compact ? "▾" : "▴"}</span>
            </button>
          ) : null}
        </div>
      </div>

      {reportError && <p role="alert" className="px-3 py-2 text-sm text-accent-red">{t("shiftReport.reportLoadError")}</p>}
      <div className={`grid grid-cols-3 divide-x divide-border-primary/50 bg-bg-secondary/25 ${compact ? "border-t border-border-primary/40" : "border-b border-border-primary/60"}`}>
        <div className="min-w-0 px-3 py-2">
          <div className="truncate text-[10px] font-medium text-text-muted">{t("shiftReport.transactions")}</div>
          <div className="mt-0.5 truncate font-mono text-sm font-semibold text-text-primary">
            {shift.total_transactions}
          </div>
        </div>
        <div className="min-w-0 px-3 py-2">
          <div className="truncate text-[10px] font-medium text-text-muted">{t("shiftReport.volume")}</div>
          <div className="mt-0.5 truncate font-mono text-sm font-semibold text-accent-blue">
            {fmtL.format(shift.total_volume)} L
          </div>
        </div>
        <div className="min-w-0 px-3 py-2">
          <div className="truncate text-[10px] font-medium text-text-muted">{t("shiftReport.revenue")}</div>
          <div className="mt-0.5 truncate font-mono text-sm font-semibold text-accent-amber">
            {fmtSum.format(shift.total_amount)} {t("shiftReport.currency")}
          </div>
        </div>
      </div>

      {!compact ? <div className="space-y-4 p-3">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {shift.position_totals.length > 0 ? (
          <div>
            <div className="mb-2 text-xs font-semibold text-text-muted">
              {t("shiftReport.byDispenser")}
            </div>
            <div className="overflow-hidden rounded border border-border-primary/50">
              {shift.position_totals.map((pt) => (
                <div
                  key={pt.fp_id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border-primary/40 px-3 py-2 last:border-b-0"
                >
                  <span className="text-sm font-semibold text-text-primary">{pt.label}</span>
                  <div className="flex flex-wrap gap-4 font-mono text-sm font-medium text-text-tertiary">
                    <span className="text-text-muted">{pt.transactions_count} {t("shiftReport.countSuffix")}</span>
                    <span className="text-accent-blue">{fmtL.format(pt.total_volume)} L</span>
                    <span className="text-text-secondary">{fmtSum.format(pt.total_amount)} {t("shiftReport.currency")}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {productTotals && productTotals.length > 0 ? (
          <div>
            <div className="mb-2 text-xs font-semibold text-text-muted">
              {t("shiftReport.byFuelType")}
            </div>
            <div className="overflow-hidden rounded border border-border-primary/50">
              {productTotals.map((pt) => (
                <div
                  key={pt.name}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border-primary/40 px-3 py-2 last:border-b-0"
                >
                  <span className="text-sm font-semibold text-text-primary">{pt.name}</span>
                  <div className="flex flex-wrap gap-4 font-mono text-sm font-medium text-text-tertiary">
                    <span className="text-text-muted">{pt.count} {t("shiftReport.countSuffix")}</span>
                    <span className="text-accent-emerald">{fmtL.format(pt.volume)} L</span>
                    <span className="text-accent-amber">{fmtSum.format(pt.amount)} {t("shiftReport.currency")}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {(shift.nozzle_totalizers?.length ?? 0) > 0 ? (
        <div>
          <div className="mb-2 text-xs font-semibold text-text-muted">
            {t("shiftReport.meterReadings")} (L)
          </div>
          <div className="overflow-x-auto rounded border border-border-primary/50">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-bg-secondary text-xs text-text-muted">
                  <th className="px-3 py-2 text-left font-semibold">{t("shiftReport.nozzle")}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t("shiftReport.meterOpen")}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t(shift.status === "ACTIVE" ? "shiftReport.meterCurrent" : "shiftReport.meterClose")}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t("shiftReport.meterChange")}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t("shiftReport.recorded")}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t("shiftReport.variance")}</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {shift.nozzle_totalizers!.map((nt) => {
                  // Rounding in the meter and in the sale figures makes sub-litre
                  // differences meaningless; only flag a real discrepancy.
                  const off = nt.variance_volume != null && Math.abs(nt.variance_volume) >= 0.5;
                  const reading = shift.status === "ACTIVE" ? nt.current_volume : nt.close_volume;
                  return (
                    <tr
                      key={`${nt.fp_id}-${nt.nozzle_index}`}
                      className="border-t border-border-primary/20"
                    >
                      <td className="px-3 py-2 font-sans font-semibold text-text-primary">
                        {nt.label || nt.fp_id} · {t("shiftReport.nozzleShort")}{nt.nozzle_index}
                        {nt.product_name ? (
                          <span className="ml-2 font-normal text-text-muted">{nt.product_name}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right text-text-tertiary">
                        {nt.open_volume != null ? fmtL.format(nt.open_volume) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-text-tertiary">
                        {reading != null ? fmtL.format(reading) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-accent-blue">
                        {nt.dispensed_volume != null ? fmtL.format(nt.dispensed_volume) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-accent-emerald">
                        {fmtL.format(nt.recorded_volume)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-bold ${off ? "text-accent-red" : "text-text-muted"}`}
                      >
                        {nt.variance_volume != null ? fmtL.format(nt.variance_volume) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-xs text-text-muted">{t(shift.status === "ACTIVE" ? "shiftReport.meterLiveHint" : "shiftReport.meterHint")}</p>
        </div>
      ) : null}

      {shift.notes ? (
        <div className="border-l-2 border-border-primary bg-bg-secondary/25 px-3 py-2">
          <div className="text-xs font-semibold text-text-muted">
            {t("shiftReport.notes")}
          </div>
          <p className="mt-1 text-sm text-text-secondary">{shift.notes}</p>
        </div>
      ) : null}

      {onViewTransactions && (
        <div className="flex justify-end border-t border-border-primary/50 pt-3">
          <button
            type="button"
            onClick={() => onViewTransactions(shift.id)}
            className="text-xs font-semibold text-accent-blue underline-offset-2 hover:underline"
          >
            {t("shiftReport.viewTransactions")} →
          </button>
        </div>
      )}
      </div> : null}
    </div>
  );
}
