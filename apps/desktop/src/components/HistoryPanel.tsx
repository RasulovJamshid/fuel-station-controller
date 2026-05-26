import { useCallback, useEffect, useState, useMemo } from "react";
import type { Shift, Transaction, TxStatus } from "../types/api";
import { txStatusLabel, txStatusParentId } from "../types/api";

// ── print helpers ─────────────────────────────────────────────────────────────

const PRINT_ROOT_ID = "azs-print-root";
const PRINT_STYLE_ID = "azs-print-style";

const PRINT_CSS = `
  #${PRINT_ROOT_ID} { display: none; }
  @media print {
    body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }
    #${PRINT_ROOT_ID} {
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

  const totalVol = rows.reduce((s, r) => s + r.volume, 0);
  const totalAmt = rows.reduce((s, r) => s + r.amount, 0);
  const cnt = summary?.count ?? rows.length;
  const vol = summary?.total_volume ?? totalVol;
  const amt = summary?.total_amount ?? totalAmt;

  const rowsHtml = rows.map((r, i) => `
    <tr class="${i % 2 === 1 ? "alt" : ""}">
      <td class="c m">${i + 1}</td>
      <td>${r.product_name}</td>
      <td class="r m">${fmtV(r.volume)}</td>
      <td class="r m">${fmtA(r.amount)}</td>
      <td class="m" style="font-size:9.5px">${fmtDt(r.started_at)}</td>
      <td>${r.label || r.fp_id}</td>
      <td class="c">${txStatusLabel(r.status)}</td>
    </tr>`).join("");

  return `
    <style>${INNER_CSS}</style>
    <div class="ph">
      <h1>Realizatsiya hisoboti</h1>
      <div class="meta">
        <span><b>Davr:</b> ${dateLabel}</span>
        <span><b>Status:</b> ${filterLabel}</span>
        ${productLabel !== "Barcha" ? `<span><b>Yoqilg'i:</b> ${productLabel}</span>` : ""}
        <span><b>Chop etildi:</b> ${now}</span>
      </div>
    </div>
    <div class="ps">
      <div class="c"><div class="l">Tranzaksiyalar</div><div class="v">${cnt} ta</div></div>
      <div class="c">
        <div class="l">Jami litr</div>
        <div class="v">${fmtV(vol)} L</div>
        ${cnt > 0 ? `<div class="s">o'rtacha ${fmtV(vol / cnt)} L</div>` : ""}
      </div>
      <div class="c">
        <div class="l">Jami summa</div>
        <div class="v">${fmtA(amt)} so'm</div>
        ${cnt > 0 ? `<div class="s">o'rtacha ${fmtA(Math.round(amt / cnt))} so'm</div>` : ""}
      </div>
    </div>
    <table>
      <thead><tr>
        <th class="c">T/R</th>
        <th>Yoqilg'i</th>
        <th class="r">Litr</th>
        <th class="r">Summa</th>
        <th>Sana / vaqt</th>
        <th>Kolonka</th>
        <th class="c">Status</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot><tr>
        <td colspan="2" class="r">Jami:</td>
        <td class="r m">${fmtV(totalVol)} L</td>
        <td class="r m">${fmtA(totalAmt)} so'm</td>
        <td colspan="3"></td>
      </tr></tfoot>
    </table>
    <div class="foot">Jami ${rows.length} ta yozuv chop etildi</div>
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
  { id: "main",     label: "Asosiy",          statuses: "COMPLETED,CONTINUED_FROM" },
  { id: "all",      label: "Hammasi",         statuses: "" },
  { id: "aborted",  label: "Bekor qilingan",  statuses: "ABORTED" },
  { id: "stopped",  label: "To'xtatilgan",    statuses: "STOPPED" },
] as const;

type StatusFilterId = typeof STATUS_FILTERS[number]["id"];

// ── date preset config ────────────────────────────────────────────────────────

const DATE_PRESETS = [
  { id: "shift",     label: "Joriy shift" },
  { id: "today",     label: "Bugun"       },
  { id: "yesterday", label: "Kecha"       },
  { id: "last7",     label: "7 kun"       },
  { id: "last30",    label: "30 kun"      },
  { id: "thisMonth", label: "Bu oy"       },
  { id: "all",       label: "Hammasi"     },
  { id: "custom",    label: "Sana…"       },
] as const;

// ── pill helpers ──────────────────────────────────────────────────────────────

function productPill(name: string) {
  const lower = name.toLowerCase();
  let colors = "bg-bg-tertiary text-text-secondary ring-border-primary";
  if (lower.includes("95"))
    colors = "bg-accent-amber/20 text-accent-amber-light ring-accent-amber/40";
  else if (lower.includes("92") || lower.includes("80"))
    colors = "bg-accent-emerald/20 text-accent-emerald-light ring-accent-emerald/40";
  else if (lower.includes("dt") || lower.includes("diesel"))
    colors = "bg-accent-blue/20 text-accent-blue ring-accent-blue/40";
  return `inline-flex max-w-full truncate rounded-md px-2 py-0.5 text-[11px] font-bold ring-1 ${colors}`;
}

function statusPill(s: TxStatus) {
  const base = "inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider";
  switch (txStatusLabel(s)) {
    case "COMPLETED":      return `${base} bg-accent-emerald/15 text-accent-emerald ring-1 ring-accent-emerald/30`;
    case "ABORTED":        return `${base} bg-accent-amber/15 text-accent-amber ring-1 ring-accent-amber/30`;
    case "STOPPED":        return `${base} bg-accent-red/15 text-accent-red ring-1 ring-accent-red/30`;
    case "CONTINUED_FROM": return `${base} bg-accent-blue/15 text-accent-blue ring-1 ring-accent-blue/30`;
    default:               return `${base} bg-bg-tertiary text-text-tertiary ring-1 ring-border-primary`;
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
      className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors border whitespace-nowrap
        ${active
          ? "bg-accent-blue text-white border-accent-blue shadow-sm"
          : "bg-bg-primary/80 text-text-secondary border-border-primary/50 hover:bg-bg-tertiary hover:text-text-primary"
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

  // reset page + clear summary when filters change
  useEffect(() => {
    setPage(0);
    setSummary(null);
  }, [fromMs, untilMs, statusesParam]);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const s = await invoke<TxSummary>("get_transactions_summary", {
        statuses: statusesParam || null,
        fromMs:   fromMs  ?? null,
        untilMs:  untilMs ?? null,
      });
      setSummary(s);
    } catch {
      // non-critical, ignore
    } finally {
      setSummaryLoading(false);
    }
  }, [statusesParam, fromMs, untilMs]);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setErr(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<Transaction[]>("get_transactions", {
        limit:    PAGE_SIZE,
        offset:   p * PAGE_SIZE,
        statuses: statusesParam || null,
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
  }, [statusesParam, fromMs, untilMs]);

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
        fromMs:   fromMs  ?? null,
        untilMs:  untilMs ?? null,
      });

      const statusLabel = STATUS_FILTERS.find((f) => f.id === statusFilter)?.label ?? statusFilter;
      const dateLabel = (() => {
        const p = DATE_PRESETS.find((d) => d.id === datePreset);
        if (datePreset === "custom") return `${customFrom || "—"} → ${customUntil || "bugun"}`;
        if (datePreset === "all")   return "Barcha vaqt";
        if (datePreset === "shift" && fromMs)
          return `Joriy shift (${new Date(fromMs).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} → hozir)`;
        if (fromMs) {
          const f = toDateInputVal(fromMs);
          return `${p?.label ?? ""} (${f}${untilMs ? " → " + toDateInputVal(untilMs - 1) : " → bugun"})`;
        }
        return p?.label ?? datePreset;
      })();

      const innerHtml = buildPrintInnerHtml(
        allRows,
        summary,
        statusLabel,
        dateLabel,
        filterProduct === "all" ? "Barcha" : filterProduct,
      );

      // Inject print root div
      const existing = document.getElementById(PRINT_ROOT_ID);
      existing?.remove();
      const root = document.createElement("div");
      root.id = PRINT_ROOT_ID;
      root.innerHTML = innerHtml;
      document.body.appendChild(root);

      // Inject @media print styles that hide everything else
      const existingStyle = document.getElementById(PRINT_STYLE_ID);
      existingStyle?.remove();
      const styleEl = document.createElement("style");
      styleEl.id = PRINT_STYLE_ID;
      styleEl.textContent = PRINT_CSS;
      document.head.appendChild(styleEl);

      // Clean up after printing (fires when print dialog closes)
      const cleanup = () => {
        document.getElementById(PRINT_ROOT_ID)?.remove();
        document.getElementById(PRINT_STYLE_ID)?.remove();
      };
      window.addEventListener("afterprint", cleanup, { once: true });

      window.print();
    } catch {
      // silently ignore — user can retry
    } finally {
      setPrintLoading(false);
    }
  }, [statusesParam, fromMs, untilMs, statusFilter, datePreset, customFrom, customUntil, filterProduct, summary]);

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
  const pageVol = processedRows.reduce((s, r) => s + r.volume, 0);
  const pageAmt = processedRows.reduce((s, r) => s + r.amount, 0);

  const handleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDesc(!sortDesc);
    else { setSortCol(col); setSortDesc(true); }
  };

  const SortIcon = ({ col }: { col: typeof sortCol }) =>
    sortCol !== col
      ? <span className="opacity-30 text-[9px] ml-1">↕</span>
      : <span className="text-[10px] ml-1 text-accent-blue">{sortDesc ? "↓" : "↑"}</span>;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border-primary/80 bg-bg-card/80 shadow-card backdrop-blur-sm print:border-none print:shadow-none print:bg-white">

      {/* ── header ── */}
      <div className={`flex flex-wrap shrink-0 items-center justify-between gap-3 border-b border-border-primary/60 bg-gradient-to-r from-bg-secondary/80 to-bg-tertiary/50 px-4 ${compact ? "py-2.5" : "py-3"} print:hidden`}>
        <h2 className={`font-bold uppercase tracking-wider text-text-primary ${compact ? "text-xs" : "text-sm"}`}>
          Realizatsiya tarixi
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filterProduct}
            onChange={(e) => setFilterProduct(e.target.value)}
            className={`rounded-lg border border-border-primary/50 bg-bg-secondary px-2 py-1 text-text-primary outline-none focus:border-accent-blue ${compact ? "text-[10px]" : "text-xs"}`}
          >
            <option value="all">Barcha yoqilg&apos;i</option>
            {products.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button
            type="button"
            disabled={printLoading}
            onClick={() => void handlePrint()}
            className="rounded-lg border border-border-primary bg-bg-primary/90 px-3 py-1 text-xs font-bold text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50 shadow-sm transition-colors"
          >
            {printLoading ? "Yuklanmoqda…" : "Chop etish"}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => { setPage(0); void load(0); }}
            className="rounded-lg border border-border-primary bg-bg-primary/90 px-3 py-1 text-xs font-bold text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50 shadow-sm transition-colors"
          >
            {loading ? "…" : "Yangilash"}
          </button>
        </div>
      </div>

      {/* ── status filter ── */}
      <div className="shrink-0 border-b border-border-primary/40 bg-bg-secondary/50 px-4 py-2 print:hidden">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-text-muted">Status:</span>
          {STATUS_FILTERS.map(({ id, label }) => (
            <QuickBtn key={id} active={statusFilter === id} onClick={() => setStatusFilter(id as StatusFilterId)}>
              {label}
            </QuickBtn>
          ))}
        </div>
      </div>

      {/* ── date-range toolbar ── */}
      <div className="shrink-0 border-b border-border-primary/40 bg-bg-secondary/40 px-4 py-2 print:hidden">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-text-muted">Davr:</span>
          {DATE_PRESETS.map(({ id, label }) => {
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
                title={disabled ? "Faol shift yo'q" : undefined}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors border whitespace-nowrap
                  ${datePreset === id
                    ? "bg-accent-blue text-white border-accent-blue shadow-sm"
                    : disabled
                      ? "bg-bg-primary/40 text-text-muted border-border-primary/30 cursor-not-allowed opacity-40"
                      : "bg-bg-primary/80 text-text-secondary border-border-primary/50 hover:bg-bg-tertiary hover:text-text-primary"
                  }`}
              >
                {label}
                {shiftTime && (
                  <span className={`ml-1 text-[9px] font-normal ${datePreset === id ? "opacity-80" : "text-text-muted"}`}>
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
                className="rounded-lg border border-border-primary/50 bg-bg-primary px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent-blue"
              />
              <span className="text-text-muted text-xs">—</span>
              <input
                type="date"
                value={customUntil}
                onChange={(e) => setCustomUntil(e.target.value)}
                className="rounded-lg border border-border-primary/50 bg-bg-primary px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent-blue"
              />
            </div>
          )}

          {datePreset !== "all" && datePreset !== "custom" && fromMs && (
            <span className="ml-auto font-mono text-[10px] text-text-muted">
              {datePreset === "shift"
                ? new Date(fromMs).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " → hozir"
                : toDateInputVal(fromMs) + (untilMs ? ` → ${toDateInputVal(untilMs - 1)}` : " → bugun")
              }
            </span>
          )}
        </div>
      </div>

      {/* ── full-filter summary cards ── */}
      <div className="shrink-0 grid grid-cols-3 gap-3 border-b border-border-primary/40 bg-bg-secondary/30 px-4 py-3 print:hidden">
        {(["count", "vol", "amt"] as const).map((card) => {
          const isLoading = summaryLoading || !summary;
          const label     = card === "count" ? "Jami tranzaksiya" : card === "vol" ? "Jami litr" : "Jami summa";
          const value     = isLoading ? "—"
            : card === "count" ? `${summary.count}`
            : card === "vol"   ? fmtVol(summary.total_volume)
            : fmtInt.format(summary.total_amount);
          const unit      = card === "count" ? "ta" : card === "vol" ? "L" : "so'm";
          const avg       = !isLoading && summary.count > 0
            ? card === "vol"
              ? `o'rtacha ${fmtVol(summary.total_volume / summary.count)} L`
              : card === "amt"
                ? `o'rtacha ${fmtInt.format(Math.round(summary.total_amount / summary.count))} so'm`
                : null
            : null;
          const color     = card === "vol" ? "text-accent-blue" : card === "amt" ? "text-accent-amber" : "text-text-primary";
          return (
            <div key={card} className="rounded-xl border border-border-primary/50 bg-bg-primary/70 px-3 py-2.5 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{label}</div>
                <div className="text-[9px] font-semibold uppercase tracking-wider text-text-muted/60 bg-bg-tertiary/60 rounded px-1 py-0.5">Davr</div>
              </div>
              <div className={`font-mono text-lg font-bold tabular-nums ${color} ${isLoading ? "opacity-40" : ""}`}>
                {value}
                <span className="ml-1 text-[11px] font-normal text-text-tertiary">{unit}</span>
              </div>
              {avg && <div className="text-[10px] text-text-muted mt-0.5">{avg}</div>}
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
          Yuklanmoqda…
        </div>
      ) : processedRows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <div className="text-3xl opacity-20">📋</div>
          <p className="text-sm font-medium text-text-muted">
            {rows.length === 0 ? "Tranzaksiyalar yo'q." : "Tanlangan filtr bo'yicha natija yo'q."}
          </p>
          {rows.length > 0 && (
            <button
              type="button"
              onClick={() => { setStatusFilter("all"); setDatePreset("all"); }}
              className="mt-1 text-xs text-accent-blue underline underline-offset-2 hover:no-underline"
            >
              Barcha filtrlarni olib tashlash
            </button>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="h-full overflow-auto overscroll-contain">
            <table className={`w-full border-collapse text-left text-text-primary ${compact ? "min-w-[36rem] text-xs" : "min-w-[44rem] text-sm"}`}>
              <thead className="sticky top-0 z-[1] border-b border-border-primary bg-bg-secondary/95 text-[10px] font-bold uppercase tracking-wider text-text-muted backdrop-blur-md shadow-sm print:bg-transparent print:text-black print:border-gray-300">
                <tr>
                  <th className="whitespace-nowrap px-4 py-3">T/R</th>
                  <th className="px-3 py-3">Yoqilg&apos;i</th>
                  <th className="whitespace-nowrap px-3 py-3 text-right cursor-pointer hover:text-text-primary transition-colors select-none" onClick={() => handleSort("volume")}>
                    Litr <SortIcon col="volume" />
                  </th>
                  <th className="whitespace-nowrap px-3 py-3 text-right cursor-pointer hover:text-text-primary transition-colors select-none" onClick={() => handleSort("amount")}>
                    Summa <SortIcon col="amount" />
                  </th>
                  <th className="whitespace-nowrap px-3 py-3 cursor-pointer hover:text-text-primary transition-colors select-none" onClick={() => handleSort("time")}>
                    Sana / vaqt <SortIcon col="time" />
                  </th>
                  <th className="px-3 py-3 cursor-pointer hover:text-text-primary transition-colors select-none" onClick={() => handleSort("pump")}>
                    Kolonka <SortIcon col="pump" />
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:text-text-primary transition-colors select-none" onClick={() => handleSort("status")}>
                    Status <SortIcon col="status" />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-secondary/50 print:divide-gray-200">
                {processedRows.map((r, i) => (
                  <tr key={r.id} className="hover:bg-bg-tertiary/40 transition-colors print:text-black">
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] font-semibold tabular-nums text-text-muted print:text-gray-600">
                      {page * PAGE_SIZE + i + 1}
                    </td>
                    <td className="max-w-[8rem] px-3 py-2.5" title={r.product_name}>
                      <span className={`${productPill(r.product_name)} print:border print:border-gray-300 print:text-black print:bg-transparent`}>
                        {r.product_name}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[11px] font-bold tabular-nums text-text-primary print:text-black">
                      {fmtVol(r.volume)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[11px] font-bold tabular-nums text-text-secondary print:text-gray-800">
                      {fmtInt.format(r.amount)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[10px] font-medium text-text-tertiary print:text-gray-700">
                      {fmtTime(r.started_at)}
                    </td>
                    <td className="px-3 py-2.5 text-xs font-bold text-text-primary print:text-black" title={r.fp_id}>
                      {r.label || r.fp_id}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`${statusPill(r.status)} print:border print:border-gray-300 print:text-black print:bg-transparent`}
                        title={txStatusParentId(r.status) ?? undefined}
                      >
                        {txStatusLabel(r.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 z-[1] border-t border-border-primary bg-bg-secondary/95 text-xs font-bold text-text-primary backdrop-blur-md shadow-[0_-4px_10px_rgba(0,0,0,0.1)] print:bg-transparent print:border-gray-400 print:text-black">
                <tr>
                  <td colSpan={2} className="px-4 py-2.5 text-right text-text-muted print:text-gray-700">
                    <span className="text-[9px] font-semibold uppercase tracking-wider bg-bg-tertiary/60 rounded px-1 py-0.5 mr-1">Sahifa</span>
                    <span className="text-[10px] uppercase tracking-wider">jami:</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[13px] text-accent-blue print:text-black">
                    {fmtVol(pageVol)} L
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[13px] text-accent-amber print:text-black">
                    {fmtInt.format(pageAmt)}
                  </td>
                  <td colSpan={3} className="px-3 py-2.5" />
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
            className="rounded-lg border border-border-primary/50 bg-bg-primary/80 px-3 py-1 text-xs font-bold text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30 transition-colors"
          >
            ← Oldingi
          </button>

          <span className="font-mono text-[11px] text-text-muted">
            {loading
              ? "Yuklanmoqda…"
              : `${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + processedRows.length} ta`
            }
          </span>

          <button
            type="button"
            disabled={!hasMore || loading}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-border-primary/50 bg-bg-primary/80 px-3 py-1 text-xs font-bold text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30 transition-colors"
          >
            Keyingi →
          </button>
        </div>
      )}
    </div>
  );
}
