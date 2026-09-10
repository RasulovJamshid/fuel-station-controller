const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Test the pure editor helpers without adding a browser/test framework dependency.
const source = fs.readFileSync(path.join(__dirname, '../src/lib/service-config.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const context = { exports: {} };
vm.runInNewContext(compiled.outputText, context);
const { copySiteSetup, nextNumber, configErrorMessage } = context.exports;

test('copying a site preserves hardware extensions while replacing identity and credentials', () => {
  const original = {
    site: { id: 'source', name: 'Source' },
    sync: { enabled: false, api_key: 'source-secret', backend_url: 'https://source.example', batch_size: 50 },
    products: [{ id: 1, uuid: 'stable-product-id', name: 'AI-92' }],
    connection: { protocol: 'azt2_0', port: 'COM3', custom_timing: 42 },
    fueling_positions: [{ id: 'FP1', nozzles: [{ index: 1, azt_address: 16, price: 10500 }] }],
    tanks: [{ product_id: 1, current_l: 9000, capacity_l: 20000 }],
    atg: { auth: { api_token: 'source-atg-secret' }, branches: [{ host: '192.168.1.10', slots: [{ slot: 1, maxima: { product_volume: 20000 } }] }] },
  };
  const target = {
    site: { id: 'destination', name: 'Destination', timezone: 'Asia/Tashkent' },
    sync: { enabled: true, api_key: 'destination-secret', backend_url: 'https://destination.example' },
  };
  const before = JSON.stringify(original);
  const result = copySiteSetup(original, target);
  assert.equal(JSON.stringify(result.site), JSON.stringify(target.site));
  assert.equal(result.sync.api_key, 'destination-secret');
  assert.equal(result.sync.backend_url, 'https://destination.example');
  assert.equal(result.sync.enabled, true);
  assert.equal(result.sync.batch_size, 50);
  assert.equal(result.atg.auth, null);
  assert.equal(result.tanks[0].current_l, 0);
  assert.equal(result.tanks[0].capacity_l, 20000);
  assert.equal(result.products[0].uuid, 'stable-product-id');
  assert.equal(result.connection.custom_timing, 42);
  assert.equal(result.fueling_positions[0].nozzles[0].azt_address, 16);
  assert.equal(result.atg.branches[0].slots[0].maxima.product_volume, 20000);
  assert.equal(JSON.stringify(original), before);
  result.site.name = 'Edited';
  assert.equal(target.site.name, 'Destination');
});

test('older configurations can be copied without optional tanks or ATG', () => {
  const target = { site: { id: 'new' }, sync: { enabled: true, api_key: 'key', backend_url: 'https://server.example' } };
  const result = copySiteSetup({ site: { id: 'old' }, sync: {} }, target);
  assert.equal(result.tanks.length, 0);
  assert.equal(result.atg, undefined);
});

test('new identifiers fill gaps and never reuse occupied IDs on exhaustion', () => {
  assert.equal(nextNumber([{ id: 1 }, { id: 3 }], 'id'), 2);
  assert.equal(nextNumber([{ slot: 1 }, { slot: 2 }, { slot: 3 }, { slot: 4 }], 'slot', 4), 5);
});

test('validation errors are readable, including multiple server errors', () => {
  assert.equal(configErrorMessage({ response: { data: { message: ['Unknown product', 'Duplicate address'] } } }, 'Fallback'), 'Unknown product\nDuplicate address');
  assert.equal(configErrorMessage({}, 'Fallback'), 'Fallback');
});
