const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');
const { renderToStaticMarkup } = require('react-dom/server');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return resolve.call(this, request.startsWith('@/') ? path.resolve(__dirname, '../src', request.slice(2)) : request, ...args);
};
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
};
const { ServiceConfigWizard } = require('../src/components/service-config-wizard.tsx');
const { prepareSetup, validateSetup } = require('../src/lib/service-setup.ts');
const { setupMessages } = require('../src/lib/service-setup-i18n.ts');
const fixture = () => {
  const c = prepareSetup(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../services/dispenser-service/site.mock.json'), 'utf8')));
  c.tanks = []; c.atg = null;
  c.fueling_positions = [{ id: 'FP1', label: 'Pump 1', address_byte: 1, active: true, nozzles: [] }];
  return c;
};
function* elements(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) yield* elements(child); return; }
  yield node;
  yield* elements(node.props?.children);
}
// Exercise actual React form handlers; focus/scroll scheduling belongs to browser QA.
global.requestAnimationFrame = () => 0;

test('walks all six steps and exports an independent named tank with ATG and nozzle products', () => {
  let config = fixture(); let step = 0;
  const view = () => ServiceConfigWizard({ config, step, language: 'en', onChange: next => { config = next; }, onStepChange: next => { step = next; } });
  const field = (name, value, checked) => {
    const node = [...elements(view())].find(e => e.props?.id === `setup.${name}`);
    assert.ok(node, `Missing field ${name}`);
    node.props.onChange({ target: { value, checked } });
  };
  const click = label => {
    const node = [...elements(view())].find(e => e.props?.children === label && typeof e.props.onClick === 'function');
    assert.ok(node, `Missing button ${label}`);
    assert.ok(!node.props.disabled, `Disabled button ${label}`);
    node.props.onClick();
  };
  field('connection.protocol', 'azt2_0'); field('connection.port', 'COM8');
  assert.equal(config.connection.data_bits, 7);
  click('Continue'); assert.equal(step, 1);
  click('Add nozzle'); click('Add nozzle');
  assert.deepEqual(config.fueling_positions[0].nozzles.map(n => n.azt_address), [1, 2]);
  click('Continue'); click('Add tank');
  field('tanks.0.label', 'North underground'); field('tanks.0.capacity_l', '30000');
  assert.equal(config.tanks[0].product_id, null);
  click('Continue'); field('atg.enabled', '', true); click('Add controller');
  field('atg.branches.0.host', '192.0.2.1'); click('Add sensor');
  assert.equal(config.atg.branches[0].slots[0].type, 'North underground');
  assert.equal(config.atg.branches[0].slots[0].tank_id, config.tanks[0].tank_id);
  click('Continue');
  field('fueling_positions.0.nozzles.1.product_id', String(config.products[1].id));
  for (const id of ['tank-source-0-0', 'tank-source-0-1']) {
    const node = [...elements(view())].find(e => e.props?.id === id);
    node.props.onChange({ target: { value: config.tanks[0].tank_id } });
  }
  click('Continue'); assert.equal(step, 5);
  assert.deepEqual(validateSetup(config), []);
  assert.match(renderToStaticMarkup(view()), /Configuration checks passed/);
  assert.match(renderToStaticMarkup(view()), /North underground/);
  const exported = JSON.parse(JSON.stringify(config));
  assert.equal(exported.tanks[0].current_l, 0);
  assert.equal(exported.tanks[0].nozzle_sources.length, 2);
  click('Previous'); click('Previous'); click('Previous');
  assert.equal(step, 2);
  field('tanks.0.product_id', String(config.products[0].id));
  field('tanks.0.product_id', '');
  assert.equal(config.tanks[0].product_id, null);
  assert.equal(config.atg.branches[0].slots[0].product_id, null);
  assert.equal(config.tanks[0].nozzle_sources.length, 2);
  assert.deepEqual(validateSetup(config), []);
});

test('all steps render in all supported languages and invalid inputs have associated messages', () => {
  const config = fixture(); config.connection.port = '';
  for (const [language, messages] of Object.entries(setupMessages)) for (let step = 0; step < 6; step++) {
    const tree = ServiceConfigWizard({ config, step, language, onChange: () => {}, onStepChange: () => {} });
    const html = renderToStaticMarkup(tree);
    assert.ok(html.includes('aria-current="step"'));
    assert.ok(html.includes(messages.guided));
    if (step === 0) {
      assert.match(html, /id="setup.connection.port" aria-invalid="true" aria-describedby="setup.connection.port.error"/);
      assert.ok(html.includes(messages.required));
    }
  }
});
