const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(output.outputText, filename);
};
const { addScannedTanks, scannedSlotMapping } = require('../src/lib/atgDiscovery.ts');
const products = [{ id: 1, name: 'AI-92' }];
const profile = { id: 1, name: 'ATG', host: '', port: 502, unit_id: 1, start_register: 1000,
  address_base: 1, register_count: 144, word_order: 'CDAB', height_unit: 'm', slots: [] };
const config = () => ({ enabled: true, poll_interval_secs: 300, modbus_timeout_secs: 10, api_url: '', tanks: [], branches: [{ ...profile, slots: [] }] });
const selection = (slot, patch = {}) => ({ host: '192.0.2.10', slot, label: `Tank ${slot}`, product_id: 1, capacity_l: 25000, ...patch });
let sequence = 0;
const newId = () => `physical-${++sequence}`;

test('adds only selected slots, including slot 12 and repeated products, with editable capacities and names', () => {
  const original = config();
  const choices = [selection(1), selection(12, { label: ' Diesel store ', capacity_l: 18000 })];
  const result = addScannedTanks(original, profile, choices, products, newId);
  assert.equal(result.branches[0].host, '192.0.2.10');
  assert.deepEqual(result.branches[0].slots.map(s => s.slot), [1, 12]);
  assert.deepEqual(result.tanks.map(t => t.product_id), [1, 1]);
  assert.equal(result.tanks[1].capacity_l, 18000);
  assert.equal(result.tanks[1].label, 'Diesel store');
  assert.notEqual(result.tanks[0].tank_id, result.tanks[1].tank_id);
  assert.equal(original.tanks.length, 0);
  const repeated = addScannedTanks(result, profile, choices, products, newId);
  assert.deepEqual(repeated, result);
});

test('links and renames an existing unmapped tank without changing its identity or opening stock', () => {
  const original = config();
  original.tanks.push({ tank_id: 'historic', product_id: 1, label: 'Old label', capacity_l: 25000, current_l: 5000 });
  const result = addScannedTanks(original, profile, [selection(3, { tank_id: 'historic', label: 'North tank' })], products, newId);
  assert.equal(result.tanks.length, 1);
  assert.equal(result.tanks[0].tank_id, 'historic');
  assert.equal(result.tanks[0].current_l, 5000);
  assert.equal(result.tanks[0].label, 'North tank');
  assert.equal(result.branches[0].slots[0].tank_id, 'historic');
  assert.equal(original.tanks[0].label, 'Old label');
});

test('selecting another controller never moves previously configured probes', () => {
  const first = addScannedTanks(config(), profile, [selection(1)], products, newId);
  const next = addScannedTanks(first, first.branches[0], [selection(1, { host: '192.0.2.20' })], products, newId);
  assert.equal(next.branches.length, 2);
  assert.deepEqual(next.branches[0], first.branches[0]);
  assert.equal(next.branches[1].host, '192.0.2.20');
  assert.equal(next.branches[1].word_order, 'CDAB');
  assert.equal(next.branches[1].height_unit, 'm');
  assert.notEqual(next.branches[0].id, next.branches[1].id);
});

test('recognizes an existing physical probe through a different register window', () => {
  const result = addScannedTanks(config(), profile, [selection(2)], products, newId);
  const shifted = { ...profile, start_register: 1012 };
  assert.equal(scannedSlotMapping(result, shifted, '192.0.2.10', 1).tank_id, result.tanks[0].tank_id);
  assert.deepEqual(addScannedTanks(result, shifted, [selection(1)], products, newId), result);
});

test('rejects invalid choices and duplicate tank assignments without partially changing the draft', () => {
  const original = config();
  original.tanks.push({ tank_id: 'tank', product_id: 1, label: 'Tank', capacity_l: 25000, current_l: 0 });
  const before = JSON.stringify(original);
  assert.throws(() => addScannedTanks(original, profile, [selection(1, { tank_id: 'tank' }), selection(2, { tank_id: 'tank' })], products, newId), /tankAlreadyMapped/);
  for (const patch of [{ capacity_l: 0 }, { label: '' }, { product_id: 99 }, { slot: 13 }]) {
    assert.throws(() => addScannedTanks(original, profile, [selection(1, patch)], products, newId), /invalidSelection/);
  }
  assert.equal(JSON.stringify(original), before);
});
