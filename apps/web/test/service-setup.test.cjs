const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(output.outputText, filename);
};
const { prepareSetup, validateSetup, assignNozzleTank, updatePosition, updateNozzle, mapSensor, newSetupNozzle } = require('../src/lib/service-setup.ts');
const { protocolPresets } = require('../src/lib/service-config.ts');
const fixture = () => prepareSetup(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../services/dispenser-service/site.mock.json'), 'utf8')));

test('named tanks work without products, including ATG, empty volumes and unrelated nozzle products', () => {
  let c = fixture();
  c.tanks = [{ tank_id: 'north', label: 'North tank', product_id: null, capacity_l: 25000, current_l: 0 }];
  c.atg = { enabled: true, branches: [{ id: 1, host: '192.0.2.1', register_count: 12, slots: [mapSensor({ slot: 1 }, c.tanks[0], c.products)] }] };
  c = assignNozzleTank(c, c.fueling_positions[0].id, 1, 'north');
  assert.equal(c.atg.branches[0].slots[0].type, 'North tank');
  assert.deepEqual(validateSetup(c), []);
  c.tanks[0].product_id = c.products[1].id;
  assert.deepEqual(validateSetup(c), []);
});

test('legacy tank identity and unknown protocol settings survive product changes and JSON export', () => {
  const c = fixture();
  const pid = c.products[0].id;
  c.tanks = [{ product_id: pid, label: 'Original', capacity_l: 25000, current_l: 0 }];
  c.atg = { branches: [{ slots: [{ slot: 1, tank_id: 'physical-7', product_id: pid, type: 'Fuel' }] }] };
  c.connection.vendor_option = { timeout: 42 };
  const draft = prepareSetup(c);
  draft.tanks[0].label = 'Custom name'; draft.tanks[0].product_id = null;
  assert.equal(draft.tanks[0].tank_id, 'physical-7');
  assert.equal(JSON.parse(JSON.stringify(draft)).atg.branches[0].slots[0].tank_id, 'physical-7');
  assert.deepEqual(draft.connection.vendor_option, { timeout: 42 });
  assert.equal(c.tanks[0].tank_id, undefined);
});

test('renaming pumps and nozzle indices retains tank mappings; deletion removes stale sources', () => {
  let c = fixture();
  const fp = c.fueling_positions[0];
  c.tanks = [{ tank_id: 'a', nozzle_sources: [{ fp_id: fp.id, nozzle_index: 1 }] }, { tank_id: 'b' }];
  c = updatePosition(c, 0, { ...fp, id: 'renamed' });
  c = updateNozzle(c, 0, 0, { ...c.fueling_positions[0].nozzles[0], index: 3 });
  assert.deepEqual(c.tanks[0].nozzle_sources, [{ fp_id: 'renamed', nozzle_index: 3 }]);
  c = assignNozzleTank(c, 'renamed', 3, 'b');
  assert.deepEqual(c.tanks[0].nozzle_sources, []);
  assert.deepEqual(c.tanks[1].nozzle_sources, [{ fp_id: 'renamed', nozzle_index: 3 }]);
  c = updatePosition(c, 0, { ...c.fueling_positions[0], nozzles: [] });
  assert.deepEqual(c.tanks[1].nozzle_sources, []);
});

for (const protocol of Object.keys(protocolPresets)) {
  test(`adds a valid nozzle using ${protocol} addressing rules`, () => {
    const c = fixture();
    c.atg = null; c.tanks = [];
    c.connection = { ...c.connection, protocol, data_bits: 8, stop_bits: 1, ...protocolPresets[protocol] };
    c.fueling_positions = [{ id: 'FP1', label: 'Pump 1', address_byte: 1, active: true, nozzles: [] }];
    const fp = c.fueling_positions[0];
    fp.nozzles.push(newSetupNozzle(c, fp.nozzles));
    fp.nozzles.push(newSetupNozzle(c, fp.nozzles));
    assert.deepEqual(validateSetup(c), []);
    if (['azt2_0', 'shelf_v2_2', 'texnouz_bluesky'].includes(protocol)) {
      const key = { azt2_0: 'azt_address', shelf_v2_2: 'shelf_address', texnouz_bluesky: 'bluesky_hose_number' }[protocol];
      fp.nozzles[1][key] = fp.nozzles[0][key];
      assert.ok(validateSetup(c).some(i => i.path === `fueling_positions.0.nozzles.1.${key}` && i.code === 'duplicate'));
    }
  });
}

test('reports protocol price, sensor window and duplicate physical probe errors at their fields', () => {
  const c = fixture();
  c.connection.protocol = 'azt2_0';
  c.fueling_positions[0].nozzles[0].price = 10001;
  c.atg = { enabled: true, branches: [
    { id: 1, host: '192.0.2.1', start_register: 1000, register_count: 12, slots: [{ slot: 2, type: 'Tank' }] },
    { id: 2, host: '192.0.2.1', start_register: 1012, register_count: 12, slots: [{ slot: 1, type: 'Tank' }] },
  ] };
  const issues = validateSetup(c);
  assert.ok(issues.some(i => i.path === 'fueling_positions.0.nozzles.0.price' && i.code === 'aztPrice'));
  assert.ok(issues.some(i => i.path === 'atg.branches.0.slots.0.slot' && i.code === 'integerRange'));
  assert.ok(issues.some(i => i.path === 'atg.branches.1.slots.0.slot' && i.code === 'duplicateProbe'));
});

test('mapping a sensor uses tank capacity without stale product-specific overrides', () => {
  const sensor = mapSensor({ slot: 1, product_id: 3, type: 'Old', capacity_l: 100, maxima: { product_volume: 100, water_height: 200 } }, { tank_id: 'tank', label: 'Water tank', capacity_l: 25000 }, []);
  assert.equal(sensor.product_id, null);
  assert.equal(sensor.type, 'Water tank');
  assert.equal(sensor.capacity_l, undefined);
  assert.deepEqual(sensor.maxima, { water_height: 200 });
});

test('preserves existing integration-only ATG slots without a local tank or product', () => {
  const c = fixture();
  c.tanks = [];
  c.atg = { enabled: true, branches: [{ id: 1, host: '192.0.2.1', slots: [{ slot: 1, tank_id: 'external-only', type: 'External tank' }] }] };
  assert.deepEqual(validateSetup(c), []);
});
