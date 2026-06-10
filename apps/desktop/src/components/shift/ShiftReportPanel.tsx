import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Shift, Transaction } from "../../types/api";

const fmtL = new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 1 });
const fmtSum = new Intl.NumberFormat("uz-UZ");
const SHIFT_PRINT_ROOT_ID = "azs-shift-print-root";
const SHIFT_PRINT_STYLE_ID = "azs-shift-print-style";

const SHIFT_PRINT_CSS = `
  #${SHIFT_PRINT_ROOT_ID} { display: none; }
  @media print {
    body > *:not(#${SHIFT_PRINT_ROOT_ID}) { display: none !important; }
    #${SHIFT_PRINT_ROOT_ID} {
      display: block !important;
      position: fixed;
      inset: 0;
      background: #fff;
      z-index: 999999;
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

  const byFuelHtml = shift.status === "ACTIVE" && productTotals && productTotals.length > 0 ? `
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
    ${notesHtml}
    <div class="foot">${t("shiftReport.printedAt") || "Chop etildi"}: ${now}</div>
  `;
}

export function ShiftReportPanel({ shift, onViewTransactions }: { shift: Shift; onViewTransactions?: (shiftId: string) => void }) {
  const { t } = useTranslation();
  const durationMs = (shift.ended_at ?? Date.now()) - shift.started_at;
  const durationHrs = (durationMs / 3_600_000).toFixed(1);
  const startStr = new Date(shift.started_at).toLocaleString("uz-UZ");
  const endStr = shift.ended_at ? new Date(shift.ended_at).toLocaleString("uz-UZ") : t("shiftReport.untilNow");

  const [productTotals, setProductTotals] = useState<{name: string; volume: number; amount: number; count: number}[] | null>(null);

  useEffect(() => {
    if (shift.status !== "ACTIVE") {
      setProductTotals([]);
      return;
    }
    async function load() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const list = await invoke<Transaction[]>("get_transactions", {
          shiftId: shift.id,
          statuses: "COMPLETED",
          limit: 2000,
          offset: 0,
        });
        if (list.length > 0) {
          const map = new Map<string, {name: string, volume: number, amount: number, count: number}>();
          for (const tx of list) {
            const existing = map.get(tx.product_name) || { name: tx.product_name, volume: 0, amount: 0, count: 0 };
            existing.volume += tx.volume;
            existing.amount += tx.amount;
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
  }, [shift.id, shift.status]);

  const handlePrint = useCallback(() => {
    const existing = document.getElementById(SHIFT_PRINT_ROOT_ID);
    existing?.remove();

    const root = document.createElement("div");
    root.id = SHIFT_PRINT_ROOT_ID;
    root.innerHTML = buildShiftPrintHtml(shift, productTotals, t);
    document.body.appendChild(root);

    const existingStyle = document.getElementById(SHIFT_PRINT_STYLE_ID);
    existingStyle?.remove();

    const styleEl = document.createElement("style");
    styleEl.id = SHIFT_PRINT_STYLE_ID;
    styleEl.textContent = SHIFT_PRINT_CSS;
    document.head.appendChild(styleEl);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.getElementById(SHIFT_PRINT_ROOT_ID)?.remove();
      document.getElementById(SHIFT_PRINT_STYLE_ID)?.remove();
      window.removeEventListener("afterprint", cleanup);
      window.removeEventListener("focus", onFocus);
    };
    const onFocus = () => window.setTimeout(cleanup, 0);

    window.addEventListener("afterprint", cleanup, { once: true });
    window.addEventListener("focus", onFocus, { once: true });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.print();
        window.setTimeout(cleanup, 400);
      });
    });
  }, [shift, productTotals, t]);

  return (
    <div className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-5 shadow-card backdrop-blur-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-lg font-bold text-text-primary">{shift.operator_name}</div>
          <div className="text-sm font-medium text-text-secondary">
            {shift.shift_name ?? t("shiftReport.shiftFallback")}
            {shift.scheduled_start && shift.scheduled_end
              ? ` · ${shift.scheduled_start}–${shift.scheduled_end}`
              : ""}{" "}
            · {durationHrs} {t("shiftReport.hours")}
          </div>
          <div className="mt-1 text-sm text-text-muted">
            {startStr} — {endStr}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => handlePrint()}
            className="rounded-lg border border-border-primary bg-bg-secondary px-3 py-1.5 text-sm font-semibold text-text-primary hover:bg-bg-tertiary"
          >
            {t("shiftReport.print")}
          </button>
          <span
            className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wider ${
              shift.status === "ACTIVE"
                ? "border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald"
                : "border-border-secondary bg-bg-secondary text-text-secondary"
            }`}
          >
            {t(`shiftStatus.${shift.status}`)}
          </span>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border-primary/60 bg-bg-secondary/60 p-4 transition-colors hover:bg-bg-tertiary/60">
          <div className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">{t("shiftReport.transactions")}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-text-primary">
            {shift.total_transactions}
          </div>
        </div>
        <div className="rounded-xl border border-border-primary/60 bg-bg-secondary/60 p-4 transition-colors hover:bg-bg-tertiary/60">
          <div className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">{t("shiftReport.volume")}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-text-primary">
            {fmtL.format(shift.total_volume)} L
          </div>
        </div>
        <div className="rounded-xl border border-border-primary/60 bg-bg-secondary/60 p-4 transition-colors hover:bg-bg-tertiary/60">
          <div className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">{t("shiftReport.revenue")}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-text-primary">
            {fmtSum.format(shift.total_amount)} {t("shiftReport.currency")}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {shift.position_totals.length > 0 ? (
          <div>
            <div className="mb-2 text-xs font-bold uppercase tracking-wider text-text-muted">
              {t("shiftReport.byDispenser")}
            </div>
            <div className="space-y-1.5">
              {shift.position_totals.map((pt) => (
                <div
                  key={pt.fp_id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-primary/30 bg-bg-tertiary/40 px-3 py-2.5 transition-colors hover:bg-bg-tertiary/70"
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

        {shift.status === "ACTIVE" && productTotals && productTotals.length > 0 ? (
          <div>
            <div className="mb-2 text-xs font-bold uppercase tracking-wider text-text-muted">
              {t("shiftReport.byFuelType")}
            </div>
            <div className="space-y-1.5">
              {productTotals.map((pt) => (
                <div
                  key={pt.name}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-primary/30 bg-bg-tertiary/40 px-3 py-2.5 transition-colors hover:bg-bg-tertiary/70"
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

      {shift.notes ? (
        <div className="rounded-xl border border-border-primary/40 bg-bg-secondary/50 px-4 py-3">
          <div className="text-xs font-bold uppercase tracking-wider text-text-muted">
            {t("shiftReport.notes")}
          </div>
          <p className="mt-1 text-sm text-text-secondary">{shift.notes}</p>
        </div>
      ) : null}

      {onViewTransactions && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onViewTransactions(shift.id)}
            className="text-xs font-semibold text-accent-blue underline-offset-2 hover:underline"
          >
            {t("shiftReport.viewTransactions")} →
          </button>
        </div>
      )}
    </div>
  );
}
