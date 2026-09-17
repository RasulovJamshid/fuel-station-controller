import ExcelJS from "exceljs";
import type { Shift, Transaction } from "../types/api";
import { txStatusI18nKey, txStatusParentId } from "../types/api";

type Translate = (key: string) => string;
type Cell = string | number | null;
export type HistoryExportFilters = {
  statuses: string | null;
  shiftId: string | null;
  fromMs: number | null;
  untilMs: number | null;
};
type PageRequest = HistoryExportFilters & { limit: number; offset: number };

export async function loadExportTransactions(
  fetchPage: (request: PageRequest) => Promise<Transaction[]>,
  filters: HistoryExportFilters,
): Promise<Transaction[]> {
  const rows = new Map<string, Transaction>();
  // Freeze the upper bound so new sales do not continually extend the export.
  const untilMs = Math.min(filters.untilMs ?? Infinity, Date.now());
  for (let offset = 0; ; offset += 500) {
    const page = await fetchPage({ ...filters, untilMs, limit: 500, offset });
    for (const row of page) rows.set(row.id, row);
    if (page.length < 500) break;
  }
  return [...rows.values()];
}

function addSheet(workbook: ExcelJS.Workbook, name: string, headers: string[], rows: Cell[][]) {
  // Excel limits worksheet names to 31 characters and excludes these symbols.
  const sheet = workbook.addWorksheet(name.replace(/[\\/*?:\[\]]/g, " ").slice(0, 31));
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: headers.length } };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };
  sheet.getRow(1).height = 24;
  headers.forEach((header, index) => {
    sheet.getColumn(index + 1).width = Math.min(44, Math.max(16, header.length + 2));
  });
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    row.eachCell((cell) => {
      if (typeof cell.value === "number") cell.numFmt = "#,##0.00";
    });
  });
  return sheet;
}

// Store local wall-clock timestamps as text so Excel does not shift their timezone.
function localTime(timestamp: number | null | undefined): string | null {
  if (timestamp == null) return null;
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function addTransactionSheet(workbook: ExcelJS.Workbook, rows: Transaction[], combined: boolean, t: Translate) {
  const volume = (row: Transaction) => combined && txStatusParentId(row.status) !== null ? row.combined_volume ?? row.volume : row.volume;
  const amount = (row: Transaction) => combined && txStatusParentId(row.status) !== null ? row.combined_amount ?? row.amount : row.amount;
  const sheet = addSheet(workbook, t("history.title"), [
    t("excel.transactionId"), t("history.colDateTime"), t("excel.completedAt"),
    t("history.colDispenser"), t("shiftReport.nozzle"), t("history.colFuel"),
    t("dispenser.price"), t("history.colLiters"), t("history.colAmount"),
    t("history.colStatus"), t("history.colOperator"), t("excel.shiftId"),
  ], rows.map((row) => [
    row.id, localTime(row.started_at), localTime(row.completed_at), row.label || row.fp_id,
    row.nozzle_index, row.product_name, row.price, volume(row), amount(row),
    t(txStatusI18nKey(row.status)), row.operator_name ?? null, row.shift_id ?? null,
  ]));
  sheet.getColumn(5).numFmt = "0";
}

function forwardDelta(open: number | null | undefined, end: number | null | undefined): number | null {
  return open != null && end != null && end >= open ? end - open : null;
}

function addTotalizerSheet(workbook: ExcelJS.Workbook, shift: Shift, t: Translate) {
  const endLabel = t(shift.status === "ACTIVE" ? "shiftReport.meterCurrent" : "shiftReport.meterClose");
  const liters = t("history.colLiters");
  const currency = t("history.currency");
  const meters = addSheet(workbook, t("shiftReport.meterReadings"), [
    t("history.colDispenser"), t("shiftReport.nozzle"), t("history.colFuel"),
    `${t("shiftReport.meterOpen")} (${liters})`, `${endLabel} (${liters})`,
    `${t("shiftReport.meterChange")} (${liters})`, `${t("shiftReport.recorded")} (${liters})`,
    `${t("shiftReport.variance")} (${liters})`,
    `${t("shiftReport.meterOpen")} (${currency})`, `${endLabel} (${currency})`,
    `${t("shiftReport.meterChange")} (${currency})`, t("excel.shiftId"),
  ], (shift.nozzle_totalizers ?? []).map((row) => {
    const endVolume = shift.status === "ACTIVE" ? row.current_volume : row.close_volume;
    const endAmount = shift.status === "ACTIVE" ? row.current_amount : row.close_amount;
    const volumeChange = forwardDelta(row.open_volume, endVolume);
    return [
      row.label || row.fp_id, row.nozzle_index, row.product_name, row.open_volume ?? null,
      endVolume ?? null, volumeChange, row.recorded_volume,
      volumeChange == null ? null : volumeChange - row.recorded_volume,
      row.open_amount ?? null, endAmount ?? null, forwardDelta(row.open_amount, endAmount), shift.id,
    ];
  }));
  meters.getColumn(2).numFmt = "0";
  // Transaction filters may cover only part of a shift; meter boundaries cover the full shift.
  meters.addRow([]);
  meters.addRow([t("excel.totalizerScope")]);
}

export function buildHistoryWorkbook(
  rows: Transaction[], filters: HistoryExportFilters, product: string, t: Translate, shift: Shift | null = null,
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AZS Manager";
  const combined = !!filters.statuses && !filters.statuses.includes("STOPPED");
  const volume = (row: Transaction) => combined && txStatusParentId(row.status) !== null ? row.combined_volume ?? row.volume : row.volume;
  const amount = (row: Transaction) => combined && txStatusParentId(row.status) !== null ? row.combined_amount ?? row.amount : row.amount;
  addTransactionSheet(workbook, rows, combined, t);
  addSheet(workbook, t("excel.summary"), [t("excel.field"), t("excel.value")], [
    [t("excel.exportedAt"), localTime(Date.now())],
    [t("excel.from"), localTime(filters.fromMs)],
    [t("excel.until"), localTime(filters.untilMs)],
    [t("history.colStatus"), filters.statuses?.split(",").map((status) => t(`txStatus.${status}`)).join(", ") || t("history.statusAll")],
    [t("excel.shiftId"), filters.shiftId],
    [t("history.colFuel"), product],
    [t("history.totalTransactions"), rows.length],
    [t("history.totalLiters"), rows.reduce((sum, row) => sum + volume(row), 0)],
    [t("history.totalAmount"), rows.reduce((sum, row) => sum + amount(row), 0)],
  ]);
  if (shift) addTotalizerSheet(workbook, shift, t);
  return workbook;
}

export function buildShiftWorkbook(shift: Shift, t: Translate, transactions: Transaction[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AZS Manager";
  // Include every shift transaction, including stopped segments and aborted sales.
  // Keep segment values here because the corresponding parent rows are included.
  addTransactionSheet(workbook, transactions, false, t);
  addSheet(workbook, t("excel.summary"), [t("excel.field"), t("excel.value")], [
    [t("excel.shiftId"), shift.id],
    [t("shiftReport.shiftFallback"), shift.shift_name],
    [t("history.colOperator"), shift.operator_name],
    [t("history.colStatus"), t(`shiftStatus.${shift.status}`)],
    [t("excel.from"), localTime(shift.started_at)],
    [t("excel.until"), localTime(shift.ended_at) ?? t("shiftReport.untilNow")],
    [t("excel.exportedAt"), localTime(Date.now())],
    [t("shiftReport.transactions"), shift.total_transactions],
    [t("shiftReport.volume"), shift.total_volume],
    [t("shiftReport.revenue"), shift.total_amount],
    [t("shiftReport.notes"), shift.notes],
  ]);
  const totalsHeaders = [t("shiftReport.transactions"), t("shiftReport.volume"), t("shiftReport.revenue")];
  const positions = addSheet(workbook, t("shiftReport.byDispenser"), [t("history.colDispenser"), ...totalsHeaders],
    shift.position_totals.map((row) => [row.label || row.fp_id, row.transactions_count, row.total_volume, row.total_amount]));
  positions.getColumn(2).numFmt = "0";
  const products = addSheet(workbook, t("shiftReport.byFuelType"), [t("history.colFuel"), ...totalsHeaders],
    (shift.product_totals ?? []).map((row) => [row.product_name, row.transactions_count, row.total_volume, row.total_amount]));
  products.getColumn(2).numFmt = "0";
  addTotalizerSheet(workbook, shift, t);
  return workbook;
}

export async function downloadWorkbook(workbook: ExcelJS.Workbook, prefix: "transactions" | "shift"): Promise<string | null> {
  const data = new Uint8Array(await workbook.xlsx.writeBuffer());
  const filename = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`;
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (isTauri()) {
    return invoke<string>("save_excel_export", { filename, data: Array.from(data) });
  }
  const url = URL.createObjectURL(new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return null;
}
