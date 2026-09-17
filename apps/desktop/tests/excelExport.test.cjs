const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const ExcelJS = require("exceljs");

// Run the pure export helpers without a browser or a running dispenser service.
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(output.outputText, filename);
};
const { loadExportTransactions, buildHistoryWorkbook, buildShiftWorkbook } = require("../src/lib/excelExport.ts");
const locale = require("../src/i18n/locales/ru.json");
const t = (key) => key.split(".").reduce((value, part) => value?.[part], locale) ?? key;
const filters = { statuses: "COMPLETED,CONTINUED_FROM", shiftId: "shift-1", fromMs: 1000, untilMs: 2000 };
const transaction = (id, overrides = {}) => ({
  id: String(id), fp_id: "fp-1", label: "Колонка 1", nozzle_index: 2, product_name: "AI-95",
  started_at: 1500, completed_at: 1800, price: 12000, volume: 10, amount: 120000,
  status: "COMPLETED", shift_id: "shift-1", operator_name: "Оператор", ...overrides,
});
const shift = {
  id: "shift-1", shift_name: "Дневная", operator_name: "Оператор", status: "CLOSED",
  started_at: 1000, ended_at: 2000, total_transactions: 1, total_volume: 10, total_amount: 120000,
  notes: "Проверено", position_totals: [{ fp_id: "fp-1", label: "Колонка 1", transactions_count: 1, total_volume: 10, total_amount: 120000 }],
  product_totals: [{ product_name: "AI-95", transactions_count: 1, total_volume: 10, total_amount: 120000 }],
  nozzle_totalizers: [{ fp_id: "fp-1", label: "Колонка 1", nozzle_index: 2, product_name: "AI-95", open_volume: 100, close_volume: 110, current_volume: 107, recorded_volume: 10, dispensed_volume: 10, variance_volume: 0 }],
};

test("history fetches every page and retains all server filters", async () => {
  const all = Array.from({ length: 1201 }, (_, i) => transaction(i));
  const calls = [];
  const result = await loadExportTransactions(async (request) => {
    calls.push(request);
    return all.slice(request.offset, request.offset + request.limit);
  }, filters);
  assert.equal(result.length, 1201);
  assert.deepEqual(calls.map((call) => call.offset), [0, 500, 1000]);
  calls.forEach((call) => assert.deepEqual(call, { ...filters, offset: call.offset, limit: 500 }));
});

test("a failed later page fails the export instead of returning a partial report", async () => {
  await assert.rejects(loadExportTransactions(async ({ offset }) => {
    if (offset) throw new Error("Service disconnected");
    return Array.from({ length: 500 }, (_, i) => transaction(i));
  }, filters), /Service disconnected/);
});

test("Excel round trip preserves Unicode, numeric values and literal formula-like text", async () => {
  const workbook = buildHistoryWorkbook([transaction(1, { product_name: '=HYPERLINK("https://example.com")', volume: 12.34 })], filters, "AI-95", t);
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = loaded.getWorksheet(t("history.title"));
  assert.equal(sheet.getCell("D2").value, "Колонка 1");
  assert.equal(sheet.getCell("F2").type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell("F2").value, '=HYPERLINK("https://example.com")');
  assert.equal(sheet.getCell("H2").value, 12.34);
  assert.equal(sheet.getCell("I2").value, 120000);
  assert.equal(sheet.views[0].ySplit, 1);
});

test("resumed sales use combined totals only when stopped segments are excluded", () => {
  const resumed = transaction(2, { status: { CONTINUED_FROM: "1" }, volume: 5, amount: 60000, combined_volume: 15, combined_amount: 180000 });
  const main = buildHistoryWorkbook([resumed], filters, "AI-95", t).getWorksheet(t("history.title"));
  assert.equal(main.getCell("H2").value, 15);
  assert.equal(main.getCell("I2").value, 180000);
  const all = buildHistoryWorkbook([resumed], { ...filters, statuses: null }, "AI-95", t).getWorksheet(t("history.title"));
  assert.equal(all.getCell("H2").value, 5);
  assert.equal(all.getCell("I2").value, 60000);
});

test("both downloads open with one transaction per row on the first sheet", async () => {
  const rows = [
    transaction(1, { status: "STOPPED" }),
    transaction(2, { status: { CONTINUED_FROM: "1" }, volume: 5, amount: 60000, combined_volume: 15, combined_amount: 180000 }),
    transaction(3, { status: "ABORTED", volume: 0, amount: 0 }),
  ];
  for (const workbook of [
    buildHistoryWorkbook(rows, { ...filters, statuses: null }, "AI-95", t),
    buildShiftWorkbook(shift, t, rows),
  ]) {
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
    const first = loaded.worksheets[0];
    assert.equal(first.name, t("history.title"));
    assert.equal(first.rowCount, rows.length + 1);
    assert.deepEqual([2, 3, 4].map((index) => first.getCell(`A${index}`).value), ["1", "2", "3"]);
    assert.equal(first.getCell("H3").value, 5);
    assert.equal(first.getCell("I3").value, 60000);
    assert.equal(loaded.worksheets[1].name, t("excel.summary"));
  }
});

test("shift workbook includes all breakdowns, uses current/closing meters, and preserves missing readings", () => {
  const closed = buildShiftWorkbook(shift, t, [transaction(1)]);
  assert.equal(closed.worksheets.length, 5);
  assert.equal(closed.getWorksheet(t("shiftReport.byFuelType")).getCell("C2").value, 10);
  assert.equal(closed.getWorksheet(t("shiftReport.meterReadings")).getCell("E2").value, 110);
  const active = buildShiftWorkbook({ ...shift, status: "ACTIVE", ended_at: null }, t, [transaction(1)]);
  assert.equal(active.getWorksheet(t("shiftReport.meterReadings")).getCell("E2").value, 107);
  const missing = buildShiftWorkbook({ ...shift, nozzle_totalizers: [{ ...shift.nozzle_totalizers[0], open_volume: undefined, close_volume: undefined }] }, t, [transaction(1)]);
  assert.equal(missing.getWorksheet(t("shiftReport.meterReadings")).getCell("D2").value, null);
  assert.equal(missing.getWorksheet(t("shiftReport.meterReadings")).getCell("E2").value, null);
});

test("history and shift exports include opening, current/closing and delta totalizers", async () => {
  const meter = {
    ...shift.nozzle_totalizers[0], open_amount: 1000000, close_amount: 1120000,
    current_amount: 1084000,
  };
  const closed = { ...shift, nozzle_totalizers: [meter] };
  const active = { ...closed, status: "ACTIVE", ended_at: null };
  for (const report of [closed, active]) {
    for (const workbook of [
      buildHistoryWorkbook([], filters, "AI-95", t, report),
      buildShiftWorkbook(report, t, [transaction(1)]),
    ]) {
      const loaded = new ExcelJS.Workbook();
      await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
      const sheet = loaded.getWorksheet(t("shiftReport.meterReadings"));
      const isActive = report.status === "ACTIVE";
      assert.equal(sheet.getCell("D2").value, 100);
      assert.equal(sheet.getCell("E2").value, isActive ? 107 : 110);
      assert.equal(sheet.getCell("F2").value, isActive ? 7 : 10);
      assert.equal(sheet.getCell("I2").value, 1000000);
      assert.equal(sheet.getCell("J2").value, isActive ? 1084000 : 1120000);
      assert.equal(sheet.getCell("K2").value, isActive ? 84000 : 120000);
      assert.equal(sheet.getCell("L2").value, report.id);
      assert.equal(sheet.getCell("A4").value, t("excel.totalizerScope"));
    }
  }
});

test("unavailable or reset totalizers export blank deltas, never invented zero readings", () => {
  for (const meter of [
    { ...shift.nozzle_totalizers[0], open_volume: undefined, open_amount: undefined, close_amount: 500 },
    { ...shift.nozzle_totalizers[0], close_volume: 5, open_amount: 1000, close_amount: 500 },
    { ...shift.nozzle_totalizers[0], close_volume: undefined, open_amount: 1000, close_amount: undefined },
  ]) {
    const workbook = buildShiftWorkbook({ ...shift, nozzle_totalizers: [meter] }, t, []);
    const sheet = workbook.getWorksheet(t("shiftReport.meterReadings"));
    assert.equal(sheet.getCell("F2").value, null);
    assert.equal(sheet.getCell("H2").value, null);
    assert.equal(sheet.getCell("K2").value, null);
  }
});

test("empty results and all supported translations produce valid workbooks", async () => {
  for (const language of ["uz", "uz-CY", "ru"]) {
    const strings = require(`../src/i18n/locales/${language}.json`);
    const translate = (key) => key.split(".").reduce((value, part) => value?.[part], strings) ?? key;
    for (const workbook of [buildHistoryWorkbook([], filters, translate("history.allFuel"), translate), buildShiftWorkbook(shift, translate, [transaction(1)])]) {
      const loaded = new ExcelJS.Workbook();
      await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
      assert.ok(loaded.worksheets.length >= 2);
      loaded.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => {
        assert.doesNotMatch(String(cell.value ?? ""), /^(excel|history|shiftReport|dispenser)\./);
      })));
    }
  }
});
