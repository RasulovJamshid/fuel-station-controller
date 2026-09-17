import assert from "node:assert/strict";
import vm from "node:vm";
import ExcelJS from "exceljs";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

// Exercise Vite's browser module graph, not Node's CommonJS ExcelJS entry point.
// Start an isolated server, or set EXCEL_TEST_URL to inspect the running app.
const server = process.env.EXCEL_TEST_URL ? null : await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 5187, strictPort: false, hmr: false },
});
try {
  if (server) await server.listen();
  const base = process.env.EXCEL_TEST_URL ?? server.resolvedUrls.local[0];
  let saved;
  const context = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, TextDecoder, URL, Blob,
    isTauri: true,
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        assert.equal(command, "save_excel_export");
        saved = args;
        return `/Downloads/${args.filename}`;
      },
    },
  });
  vm.runInContext("window = globalThis; self = globalThis;", context);
  const modules = new Map();
  async function load(url) {
    if (modules.has(url)) return modules.get(url);
    const pending = (async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      assert.equal(response.status, 200, `Browser module failed: ${url} (HTTP ${response.status})`);
      const module = new vm.SourceTextModule(await response.text(), {
        context, identifier: url,
        initializeImportMeta(meta) { meta.url = url; },
        async importModuleDynamically(specifier, referencingModule) {
          const dependency = await load(new URL(specifier, referencingModule.identifier).href);
          if (dependency.status !== "evaluated") await dependency.evaluate();
          return dependency;
        },
      });
      await module.link((specifier, referencingModule) => load(new URL(specifier, referencingModule.identifier).href));
      return module;
    })();
    modules.set(url, pending);
    return pending;
  }
  const module = await load(new URL("/src/lib/excelExport.ts", base).href);
  await module.evaluate();
  // Construct inputs in the browser context so Array/Date checks use its realm.
  context.exports = module.namespace;
  const path = await vm.runInContext(`(async () => {
    const workbook = exports.buildHistoryWorkbook([], {
      statuses: null, shiftId: null, fromMs: null, untilMs: null,
    }, "All fuel", key => key);
    return exports.downloadWorkbook(workbook, "transactions");
  })()`, context);
  assert.match(path, /^\/Downloads\/transactions-.*\.xlsx$/);
  assert.ok(saved.data.length > 1000);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(saved.data));
  assert.equal(workbook.worksheets.length, 2);
  console.log("PASS: browser Excel module loaded, generated a valid workbook, and invoked native saving");
} finally {
  await server?.close();
}
