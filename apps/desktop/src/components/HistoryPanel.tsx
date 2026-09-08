import { useCallback, useEffect, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Shift, Transaction, TxStatus } from "../types/api";
import { txStatusI18nKey, txStatusLabel, txStatusParentId } from "../types/api";
import { printHtmlDocument } from "../lib/printDocument";

// ── print helpers ─────────────────────────────────────────────────────────────

const PRINT_ROOT_ID = "azs-print-root";
const PRINT_STYLE_ID = "azs-print-style";

const PRINT_CSS = `
  #${PRINT_ROOT_ID} { display: none; }
  @media print {
    html, body {
      height: auto !important;
      overflow: visible !important;
      background: #fff !important;
    }
    body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }
    #${PRINT_ROOT_ID} {
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

const INNER_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .ph { margin-bottom: 14px; }
  .ph h1 { font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .ph .meta { display: flex; flex-wrap: wrap; gap: 20px; margin-top: 6px; color: #555; font-size: 10px; border-top: 1px solid #ddd; padding-top: 6px; }
  .ph .meta span b { color: #111; }
  .ps { display: flex; gap: 12px; margin-bottom: 14px; }
  .ps .c { border: 1px solid #ddd; border-radius: 5px; padding: 7px 12px; flex: 1; }
  .ps .c .l { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #888; margin-bottom: 2px; }
  .ps .c .v { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ps .c .s { font-size: 9px; color: #999; margin-top: 1px; }
  table { width: 100%; border-collapse: collapse; }
  thead tr { background: #f0f0f0; }
  th { padding: 5px 7px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #555; border-bottom: 2px solid #bbb; white-space: nowrap; }
  td { padding: 3.5px 7px; border-bottom: 1px solid #eee; vertical-align: middle; font-size: 10.5px; }
  .alt td { background: #fafafa; }
  tfoot td { border-top: 2px solid #999; border-bottom: none; font-weight: 700; padding-top: 5px; background: #f3f3f3; }
  .r { text-align: right; }
  .c { text-align: center; }
  .m { font-family: 'Courier New', monospace; }
  .foot { margin-top: 12px; font-size: 9px; color: #bbb; text-align: right; border-top: 1px solid #eee; padding-top: 6px; }
`;

function buildPrintInnerHtml(
  rows: Transaction[],
  summary: { count: number; total_volume: number; total_amount: number } | null,
  filterLabel: string,
  dateLabel: string,
  productLabel: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  showCombinedForContinued: boolean,
): string {
  const now = new Date().toLocaleString(undefined, {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  const fmtV  = (v: number) => v.toFixed(2);
  const fmtA  = (a: number) => new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 0 }).format(a);
  const fmtDt = (ms: number) => {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" })
      + " / "
      + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  const rowVol = (r: Transaction) =>
    txStatusParentId(r.status) !== null && showCombinedForContinued ? (r.combined_volume ?? r.volume) : r.volume;
  const rowAmt = (r: Transaction) =>
    txStatusParentId(r.status) !== null && showCombinedForContinued ? (r.combined_amount ?? r.amount) : r.amount;
  const totalVol = rows.reduce((s, r) => s + rowVol(r), 0);
  const totalAmt = rows.reduce((s, r) => s + rowAmt(r), 0);
  const cnt = summary?.count ?? rows.length;
  const vol = summary?.total_volume ?? totalVol;
  const amt = summary?.total_amount ?? totalAmt;
  const cu = t("history.currency");
  const printAllFuel = t("history.printAllFuel");

  const rowsHtml = rows.map((r, i) => `
    <tr class="${i % 2 === 1 ? "alt" : ""}">
      <td class="c m">${i + 1}</td>
      <td>${r.product_name}</td>
      <td class="r m">${fmtV(rowVol(r))}</td>
      <td class="r m">${fmtA(rowAmt(r))}</td>
      <td class="m" style="font-size:9.5px">${fmtDt(r.started_at)}</td>
      <td>${r.label || r.fp_id}</td>
      <td class="c">${t(txStatusI18nKey(r.status))}</td>
    </tr>`).join("");

  return `
    <style>${INNER_CSS}</style>
    <div class="ph">
      <h1>${t("history.printTitle")}</h1>
      <div class="meta">
        <span><b>${t("history.printPeriodLabel")}:</b> ${dateLabel}</span>
        <span><b>${t("history.printStatusLabel")}:</b> ${filterLabel}</span>
        ${productLabel !== printAllFuel ? `<span><b>${t("history.printFuelLabel")}:</b> ${productLabel}</span>` : ""}
        <span><b>${t("history.printPrintedAt")}:</b> ${now}</span>
      </div>
    </div>
    <div class="ps">
      <div class="c"><div class="l">${t("history.printCount")}</div><div class="v">${cnt} ${t("history.countSuffix")}</div></div>
      <div class="c">
        <div class="l">${t("history.printTotalLiters")}</div>
        <div class="v">${fmtV(vol)} L</div>
        ${cnt > 0 ? `<div class="s">${t("history.printAvg")} ${fmtV(vol / cnt)} L</div>` : ""}
      </div>
      <div class="c">
        <div class="l">${t("history.printTotalAmount")}</div>
        <div class="v">${fmtA(amt)} ${cu}</div>
        ${cnt > 0 ? `<div class="s">${t("history.printAvg")} ${fmtA(Math.round(amt / cnt))} ${cu}</div>` : ""}
      </div>
    </div>
    <table>
      <thead><tr>
        <th class="c">${t("history.printColNo")}</th>
        <th>${t("history.printColFuel")}</th>
        <th class="r">${t("history.printColLiters")}</th>
        <th class="r">${t("history.printColAmount")}</th>
        <th>${t("history.printColDateTime")}</th>
        <th>${t("history.printColDispenser")}</th>
        <th class="c">${t("history.printColStatus")}</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot><tr>
        <td colspan="2" class="r">${t("history.printTotal")}</td>
        <td class="r m">${fmtV(totalVol)} L</td>
        <td class="r m">${fmtA(totalAmt)} ${cu}</td>
        <td colspan="3"></td>
      </tr></tfoot>
    </table>
    <div class="foot">${rows.length} ${t("history.countSuffix")} ${t("history.printRecords")}</div>
  `;
}

// ── formatting helpers ────────────────────────────────────────────────────────

const fmtTime = (ms: number) => {
  try {
    const d = new Date(ms);
    const date = d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return `${date} / ${time}`;
  } catch {
    return "—";
  }
};
const fmtInt = new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 0 });
const fmtVol = (v: number) => v.toFixed(2);

function presetDisplay(r: Transaction, t: (key: string) => string): string | null {
  const type = r.preset_type?.toLowerCase();
  if (type === "full") return t("history.presetFull");
  if (type === "volume" && typeof r.preset_value === "number") {
    return `${fmtVol(r.preset_value)} L`;
  }
  if (type === "amount" && typeof r.preset_value === "number") {
    return `${fmtInt.format(Math.round(r.preset_value))} ${t("history.currency")}`;
  }
  return r.preset_label ?? null;
}

// ── date-range helpers ────────────────────────────────────────────────────────

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function rangeMs(
  preset: string,
  customFrom: string,
  customUntil: string,
  shiftStartMs: number | null,
): [number | null, number | null] {
  const now = new Date();
  const todayStart = startOfDay(now);
  switch (preset) {
    case "today":     return [todayStart.getTime(), null];
    case "yesterday": { const s = new Date(todayStart); s.setDate(s.getDate() - 1); return [s.getTime(), todayStart.getTime()]; }
    case "last7":     { const s = new Date(todayStart); s.setDate(s.getDate() - 6); return [s.getTime(), null]; }
    case "last30":    { const s = new Date(todayStart); s.setDate(s.getDate() - 29); return [s.getTime(), null]; }
    case "thisMonth": return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), null];
    case "shift":     return [shiftStartMs, null];
    case "custom": {
      const from  = customFrom  ? new Date(customFrom).getTime()                    : null;
      const until = customUntil ? new Date(customUntil + "T23:59:59.999").getTime() : null;
      return [from, until];
    }
    default: return [null, null];
  }
}

function toDateInputVal(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── status config ─────────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { id: "main",     labelKey: "history.statusMain",    statuses: "COMPLETED,STOPPED,CONTINUED_FROM" },
  { id: "all",      labelKey: "history.statusAll",     statuses: "" },
  { id: "aborted",  labelKey: "history.statusAborted", statuses: "ABORTED" },
  { id: "stopped",  labelKey: "history.statusStopped", statuses: "STOPPED" },
] as const;

type StatusFilterId = typeof STATUS_FILTERS[number]["id"];

// ── date preset config ────────────────────────────────────────────────────────

const DATE_PRESETS = [
  { id: "shift",     labelKey: "history.dateShift"     },
  { id: "today",     labelKey: "history.dateToday"     },
  { id: "yesterday", labelKey: "history.dateYesterday" },
  { id: "last7",     labelKey: "history.dateLast7"     },
  { id: "last30",    labelKey: "history.dateLast30"    },
  { id: "thisMonth", labelKey: "history.dateThisMonth" },
  { id: "all",       labelKey: "history.dateAll"       },
  { id: "custom",    labelKey: "history.dateCustom"    },
] as const;

// ── pill helpers ──────────────────────────────────────────────────────────────

function productPill(name: string) {
  const lower = name.toLowerCase();
  let colors = "border-border-primary text-text-secondary";
  if (lower.includes("95"))
    colors = "border-accent-amber text-text-primary";
  else if (lower.includes("92") || lower.includes("80"))
    colors = "border-accent-emerald text-text-primary";
  else if (lower.includes("dt") || lower.includes("diesel"))
    colors = "border-accent-blue text-text-primary";
  return `inline-flex max-w-full truncate border-l-2 px-1.5 py-0.5 text-xs font-medium ${colors}`;
}

function statusPill(s: TxStatus) {
  const base = "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium";
  switch (txStatusLabel(s)) {
    case "COMPLETED":      return `${base} border-accent-emerald/45 text-accent-emerald`;
    case "ABORTED":        return `${base} border-accent-amber/45 text-accent-amber`;
    case "STOPPED":        return `${base} border-accent-red/45 text-accent-red`;
    case "CONTINUED_FROM": return `${base} border-accent-blue/45 text-accent-blue`;
    default:               return `${base} border-border-primary text-text-tertiary`;
  }
}

// ── QuickBtn ──────────────────────────────────────────────────────────────────

function QuickBtn({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap
        ${active
          ? "border-accent-blue/70 bg-accent-blue/10 text-accent-blue"
          : "border-border-primary/50 bg-bg-primary text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
        }`}
    >
      {children}
    </button>
  );
}

// ── constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

interface TxSummary { count: number; total_volume: number; total_amount: number; }

// ── component ─────────────────────────────────────────────────────────────────

export function HistoryPanel(props: {
  visible: boolean;
  embedded?: boolean;
  compact?: boolean;
  currentShift?: Shift | null;
}) {
  const { t } = useTranslation();
  const [rows, setRows]           = useState<Transaction[]>([]);
  const [loading, setLoading]     = useState(false);
  const [err, setErr]             = useState<string | null>(null);
  const [hasMore, setHasMore]     = useState(false);

  // summary (full-filter totals, independent of page)
  const [summary, setSummary]               = useState<TxSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [printLoading, setPrintLoading]     = useState(false);

  // sort
  const [sortCol,  setSortCol]  = useState<"time" | "volume" | "amount" | "pump" | "status">("time");
  const [sortDesc, setSortDesc] = useState(true);

  // product filter (client-side)
  const [filterProduct, setFilterProduct] = useState("all");

  // status filter (server-side)
  const [statusFilter, setStatusFilter] = useState<StatusFilterId>("main");

  // shift filter (server-side) — null = no shift filter; defaults to active shift
  const [filterShiftId, setFilterShiftId] = useState<string | null>(props.currentShift?.id ?? null);

  // Sync shift filter when a shift starts, ends, or changes (handover)
  useEffect(() => {
    setFilterShiftId(props.currentShift?.id ?? null);
  }, [props.currentShift?.id]);

  // date range (server-side)
  const [datePreset,  setDatePreset]  = useState(props.currentShift ? "shift" : "today");
  const [customFrom,  setCustomFrom]  = useState("");
  const [customUntil, setCustomUntil] = useState("");

  // pagination
  const [page, setPage] = useState(0);

  const shiftStartMs = props.currentShift?.started_at ?? null;

  const [fromMs, untilMs] = useMemo(
    () => rangeMs(datePreset, customFrom, customUntil, shiftStartMs),
    [datePreset, customFrom, customUntil, shiftStartMs],
  );

  const statusesParam = useMemo(
    () => STATUS_FILTERS.find((f) => f.id === statusFilter)?.statuses ?? "",
    [statusFilter],
  );

  // CONTINUED_FROM rows store only the segment volume in `volume` and the full
  // combined total in `combined_volume`. When the filter excludes STOPPED rows,
  // show combined_volume so the operator sees the true fill total. When STOPPED
  // is included (all / stopped views), use segment volume to avoid double-counting.
  const showCombinedForContinued = statusesParam !== "" && !statusesParam.includes("STOPPED");
  const rowVol = (r: Transaction) =>
    txStatusParentId(r.status) !== null && showCombinedForContinued ? (r.combined_volume ?? r.volume) : r.volume;
  const rowAmt = (r: Transaction) =>
    txStatusParentId(r.status) !== null && showCombinedForContinued ? (r.combined_amount ?? r.amount) : r.amount;

  // reset page + clear summary when filters change
  useEffect(() => {
    setPage(0);
    setSummary(null);
  }, [fromMs, untilMs, statusesParam, filterShiftId]);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const s = await invoke<TxSummary>("get_transactions_summary", {
        statuses: statusesParam || null,
        shiftId:  filterShiftId ?? null,
        fromMs:   fromMs  ?? null,
        untilMs:  untilMs ?? null,
      });
      setSummary(s);
    } catch {
      // non-critical, ignore
    } finally {
      setSummaryLoading(false);
    }
  }, [statusesParam, filterShiftId, fromMs, untilMs]);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setErr(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<Transaction[]>("get_transactions", {
        limit:    PAGE_SIZE,
        offset:   p * PAGE_SIZE,
        statuses: statusesParam || null,
        shiftId:  filterShiftId ?? null,
        fromMs:   fromMs  ?? null,
        untilMs:  untilMs ?? null,
      });
      setRows(list);
      setHasMore(list.length === PAGE_SIZE);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [statusesParam, filterShiftId, fromMs, untilMs]);

  useEffect(() => {
    if (!props.visible) return;
    void load(page);
  }, [props.visible, load, page]);

  // load summary whenever filters change (not on page change)
  useEffect(() => {
    if (!props.visible) return;
    void loadSummary();
  }, [props.visible, loadSummary]);

  const handlePrint = useCallback(async () => {
    setPrintLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const allRows = await invoke<Transaction[]>("get_transactions", {
        limit:    2000,
        offset:   0,
        statuses: statusesParam || null,
        shiftId:  filterShiftId ?? null,
        fromMs:   fromMs  ?? null,
        untilMs:  untilMs ?? null,
      });

      const rowsForPrint = filterProduct === "all"
        ? allRows
        : allRows.filter((r) => r.product_name === filterProduct);

      const summaryForPrint = filterProduct === "all"
        ? summary
        : {
            count: rowsForPrint.length,
            total_volume: rowsForPrint.reduce((acc, r) => acc + rowVol(r), 0),
            total_amount: rowsForPrint.reduce((acc, r) => acc + rowAmt(r), 0),
          };

      const statusLabel = t(STATUS_FILTERS.find((f) => f.id === statusFilter)?.labelKey ?? "history.statusAll");
      const dateLabel = (() => {
        const p = DATE_PRESETS.find((d) => d.id === datePreset);
        if (datePreset === "custom") return `${customFrom || "—"} → ${customUntil || t("history.dateToday")}`;
        if (datePreset === "all")   return t("history.printAllTime");
        if (datePreset === "shift" && fromMs)
          return `${t("history.printCurrentShift")} (${new Date(fromMs).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} ${t("history.toNow")})`;
        if (fromMs) {
          const f = toDateInputVal(fromMs);
          return `${p ? t(p.labelKey) : ""} (${f}${untilMs ? " → " + toDateInputVal(untilMs - 1) : " " + t("history.toToday")})`;
        }
        return p ? t(p.labelKey) : datePreset;
      })();

      const innerHtml = buildPrintInnerHtml(
        rowsForPrint,
        summaryForPrint,
        statusLabel,
        dateLabel,
        filterProduct === "all" ? t("history.printAllFuel") : filterProduct,
        t,
        showCombinedForContinued,
      );

      await printHtmlDocument({
        rootId: PRINT_ROOT_ID,
        styleId: PRINT_STYLE_ID,
        html: innerHtml,
        css: PRINT_CSS,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPrintLoading(false);
    }
  }, [statusesParam, filterShiftId, fromMs, untilMs, statusFilter, datePreset, customFrom, customUntil, filterProduct, summary, t, showCombinedForContinued]);

  if (!props.visible) return null;

  const compact = props.compact ?? false;

  // client-side product filter + sort (applied on top of server-filtered page)
  const products = useMemo(
    () => Array.from(new Set(rows.map((r) => r.product_name))).sort(),
    [rows],
  );

  const processedRows = useMemo(() => {
    let arr = [...rows];
    if (filterProduct !== "all") arr = arr.filter((r) => r.product_name === filterProduct);
    arr.sort((a, b) => {
      let cmp = 0;
      if      (sortCol === "time")   cmp = a.started_at - b.started_at;
      else if (sortCol === "volume") cmp = a.volume - b.volume;
      else if (sortCol === "amount") cmp = a.amount - b.amount;
      else if (sortCol === "pump")   cmp = (a.label || a.fp_id).localeCompare(b.label || b.fp_id);
      else if (sortCol === "status") cmp = txStatusLabel(a.status).localeCompare(txStatusLabel(b.status));
      return sortDesc ? -cmp : cmp;
    });
    return arr;
  }, [rows, filterProduct, sortCol, sortDesc]);

  // page-level totals (for table footer only)
  const pageVol = processedRows.reduce((s, r) => s + rowVol(r), 0);
  const pageAmt = processedRows.reduce((s, r) => s + rowAmt(r), 0);

  const handleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDesc(!sortDesc);
    else { setSortCol(col); setSortDesc(true); }
  };

  const SortIcon = ({ col }: { col: typeof sortCol }) =>
    sortCol !== col
      ? <span className="opacity-30 text-xs ml-1">↕</span>
      : <span className="text-xs ml-1 text-accent-blue">{sortDesc ? "↓" : "↑"}</span>;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border-primary/70 bg-bg-card print:border-none print:bg-white">

      {/* ── header ── */}
      <div className={`flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border-primary/60 bg-bg-secondary/40 px-4 ${compact ? "py-2" : "py-2.5"} print:hidden`}>
        <h2 className={`font-semibold text-text-primary ${compact ? "text-sm" : "text-base"}`}>
          {t("history.title")}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filterProduct}
            onChange={(e) => setFilterProduct(e.target.value)}
            className={`rounded border border-border-primary/60 bg-bg-primary px-2 py-1.5 text-text-primary outline-none focus:border-accent-blue ${compact ? "text-xs" : "text-sm"}`}
          >
            <option value="all">{t("history.allFuel")}</option>
            {products.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button
            type="button"
            disabled={printLoading}
            onClick={() => void handlePrint()}
            className="rounded border border-border-primary/60 bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:opacity-50"
          >
            {printLoading ? t("history.loading") : t("history.print")}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => { setPage(0); void load(0); }}
            className="rounded border border-border-primary/60 bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:opacity-50"
          >
            {loading ? "…" : t("history.refresh")}
          </button>
        </div>
      </div>

      {/* ── filters ── */}
      <div className={`shrink-0 border-b border-border-primary/50 bg-bg-primary print:hidden ${compact ? "px-3 py-1.5" : "px-4 py-2"}`}>
        <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 w-16 shrink-0 text-xs font-medium text-text-muted">{t("history.statusLabel")}</span>
          {STATUS_FILTERS.map(({ id, labelKey }) => (
            <QuickBtn key={id} active={statusFilter === id} onClick={() => setStatusFilter(id as StatusFilterId)}>
              {t(labelKey)}
            </QuickBtn>
          ))}
          {props.currentShift && (
            <QuickBtn
              active={filterShiftId === props.currentShift.id}
              onClick={() => setFilterShiftId((prev) => prev === props.currentShift!.id ? null : props.currentShift!.id)}
            >
              {t("history.currentShift")}
            </QuickBtn>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 w-16 shrink-0 text-xs font-medium text-text-muted">{t("history.periodLabel")}</span>
          {DATE_PRESETS.map(({ id, labelKey }) => {
            const isShift   = id === "shift";
            const disabled  = isShift && !props.currentShift;
            const shiftTime = isShift && props.currentShift
              ? new Date(props.currentShift.started_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
              : null;
            return (
              <button
                key={id}
                type="button"
                disabled={disabled}
                onClick={() => !disabled && setDatePreset(id)}
                title={disabled ? t("history.noActiveShift") : undefined}
                className={`rounded border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap
                  ${datePreset === id
                    ? "border-accent-blue/70 bg-accent-blue/10 text-accent-blue"
                    : disabled
                      ? "bg-bg-primary/40 text-text-muted border-border-primary/30 cursor-not-allowed opacity-40"
                      : "border-border-primary/50 bg-bg-primary text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
                  }`}
              >
                {t(labelKey)}
                {shiftTime && (
                  <span className={`ml-1 text-[10px] font-normal ${datePreset === id ? "opacity-80" : "text-text-muted"}`}>
                    {shiftTime}
                  </span>
                )}
              </button>
            );
          })}

          {datePreset === "custom" && (
            <div className="flex items-center gap-1.5 ml-1">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded border border-border-primary/50 bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-blue"
              />
              <span className="text-text-muted text-sm">—</span>
              <input
                type="date"
                value={customUntil}
                onChange={(e) => setCustomUntil(e.target.value)}
                className="rounded border border-border-primary/50 bg-bg-input px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-blue"
              />
            </div>
          )}

          {datePreset !== "all" && datePreset !== "custom" && fromMs && (
            <span className="ml-auto font-mono text-xs text-text-muted">
              {datePreset === "shift"
                ? new Date(fromMs).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " " + t("history.toNow")
                : toDateInputVal(fromMs) + (untilMs ? ` → ${toDateInputVal(untilMs - 1)}` : " " + t("history.toToday"))
              }
            </span>
          )}
        </div>
        </div>
      </div>

      {/* ── full-filter summary ── */}
      <div className="flex shrink-0 items-stretch border-b border-border-primary/50 bg-bg-secondary/25 px-3 py-2 print:hidden">
        {(["count", "vol", "amt"] as const).map((card) => {
          const isLoading = summaryLoading || !summary;
          const label     = card === "count" ? t("history.totalTransactions") : card === "vol" ? t("history.totalLiters") : t("history.totalAmount");
          const value     = isLoading ? "—"
            : card === "count" ? `${summary.count}`
            : card === "vol"   ? fmtVol(summary.total_volume)
            : fmtInt.format(summary.total_amount);
          const unit      = card === "count" ? t("history.countSuffix") : card === "vol" ? "L" : t("history.currency");
          const color     = card === "vol" ? "text-accent-blue" : card === "amt" ? "text-accent-amber" : "text-text-primary";
          return (
            <div key={card} className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-r border-border-primary/50 px-3 first:pl-1 last:border-r-0 last:pr-1">
              <div className="truncate text-xs text-text-muted">{label}</div>
              <div className={`font-mono font-semibold tabular-nums ${color} ${isLoading ? "opacity-40" : ""} ${compact ? "text-sm" : "text-base"}`}>
                {value}
                <span className="ml-1 text-xs font-normal text-text-tertiary">{unit}</span>
              </div>
            </div>
          );
        })}
      </div>

      {err && (
        <div className="shrink-0 border-b border-accent-red/40 bg-accent-red/15 px-4 py-2.5 text-xs font-semibold text-accent-red-light">
          {err}
        </div>
      )}

      {/* ── table / empty state ── */}
      {loading && rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-sm font-semibold text-text-muted">
          {t("history.loading")}
        </div>
      ) : processedRows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <p className="text-sm font-medium text-text-muted">
            {rows.length === 0 ? t("history.noTransactions") : t("history.noResults")}
          </p>
          {rows.length > 0 && (
            <button
              type="button"
              onClick={() => { setStatusFilter("all"); setDatePreset("all"); }}
              className="mt-1 text-xs text-accent-blue underline underline-offset-2 hover:no-underline"
            >
              {t("history.clearFilters")}
            </button>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="h-full overflow-auto overscroll-contain">
            <table className={`w-full border-collapse text-left text-text-primary ${compact ? "min-w-[36rem] text-sm" : "min-w-[44rem] text-base"}`}>
              <thead className="sticky top-0 z-[1] border-b border-border-primary bg-bg-secondary text-xs font-semibold text-text-muted print:border-gray-300 print:bg-transparent print:text-black">
                <tr>
                  <th className="whitespace-nowrap px-4 py-2.5">{t("history.colNo")}</th>
                  <th className="px-3 py-2.5">{t("history.colFuel")}</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right cursor-pointer hover:text-text-primary transition-colors select-none" onClick={() => handleSort("volume")}>
                    {t("history.colLiters")} <SortIcon col="volume" />
                  </th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right cursor-pointer hover:text-text-primary transition-colors select-none" onClick={() => handleSort("amount")}>
                    {t("history.colAmount")} <SortIcon col="amount" />
                  </th>
                  <th className="whitespace-nowrap px-3 py-2.5 cursor-pointer hover:text-text-primary transition-colors select-none" onClick={() => handleSort("time")}>
                    {t("history.colDateTime")} <SortIcon col="time" />
                  </th>
                  <th className="px-3 py-2.5 cursor-pointer hover:text-text-primary transition-colors select-none" onClick={() => handleSort("pump")}>
                    {t("history.colDispenser")} <SortIcon col="pump" />
                  </th>
                  <th className="px-4 py-2.5 cursor-pointer hover:text-text-primary transition-colors select-none" onClick={() => handleSort("status")}>
                    {t("history.colStatus")} <SortIcon col="status" />
                  </th>
                  {!compact && (
                    <th className="whitespace-nowrap px-3 py-2.5 text-text-muted">{t("history.colOperator")}</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-secondary/50 print:divide-gray-200">
                {processedRows.map((r, i) => {
                  const preset = presetDisplay(r, t);
                  return (
                  <tr key={r.id} className="hover:bg-bg-tertiary/40 transition-colors print:text-black">
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs font-medium tabular-nums text-text-muted print:text-gray-600">
                      {page * PAGE_SIZE + i + 1}
                    </td>
                    <td className="max-w-[8rem] px-3 py-2.5" title={r.product_name}>
                      <span className={`${productPill(r.product_name)} print:border print:border-gray-300 print:text-black print:bg-transparent`}>
                        {r.product_name}
                      </span>
                      {preset ? (
                        <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted print:text-gray-600">
                          {preset}
                        </div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-sm font-semibold tabular-nums text-text-primary print:text-black">
                      {fmtVol(rowVol(r))}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-sm font-semibold tabular-nums text-text-secondary print:text-gray-800">
                      {fmtInt.format(rowAmt(r))}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs font-medium text-text-tertiary print:text-gray-700">
                      {fmtTime(r.started_at)}
                    </td>
                    <td className="px-3 py-2.5 text-sm font-semibold text-text-primary print:text-black" title={r.fp_id}>
                      {r.label || r.fp_id}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`${statusPill(r.status)} print:border print:border-gray-300 print:text-black print:bg-transparent`}
                        title={txStatusParentId(r.status) ?? undefined}
                      >
                        {t(txStatusI18nKey(r.status))}
                      </span>
                    </td>
                    {!compact && (
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-text-muted print:text-gray-600">
                        {r.operator_name ?? "—"}
                      </td>
                    )}
                  </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0 z-[1] border-t border-border-primary bg-bg-secondary text-xs font-semibold text-text-primary print:border-gray-400 print:bg-transparent print:text-black">
                <tr>
                  <td colSpan={2} className="px-4 py-3 text-right text-text-muted print:text-gray-700">
                    <span className="mr-1 text-[10px] text-text-tertiary">{t("history.page")}</span>
                    <span className="text-xs">{t("history.pageTotal")}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-sm font-bold text-accent-blue print:text-black">
                    {fmtVol(pageVol)} L
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-sm font-bold text-accent-amber print:text-black">
                    {fmtInt.format(pageAmt)}
                  </td>
                  <td colSpan={3} className="px-3 py-3" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── pagination bar ── */}
      {(page > 0 || hasMore) && (
        <div className="shrink-0 flex items-center justify-between border-t border-border-primary/50 bg-bg-secondary/60 px-4 py-2 print:hidden">
          <button
            type="button"
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded border border-border-primary/50 bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:opacity-30"
          >
            {t("history.previous")}
          </button>

          <span className="font-mono text-xs text-text-muted">
            {loading
              ? t("history.loading")
              : `${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + processedRows.length} ${t("history.countSuffix")}`
            }
          </span>

          <button
            type="button"
            disabled={!hasMore || loading}
            onClick={() => setPage((p) => p + 1)}
            className="rounded border border-border-primary/50 bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:opacity-30"
          >
            {t("history.next")}
          </button>
        </div>
      )}
    </div>
  );
}
