const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(output.outputText, filename);
};
const { nextAvailableNozzleIndex } = require("../src/lib/nozzleAssignments.ts");

for (const removedIndex of [1, 2, 3]) {
  test(`reuses deleted nozzle ${removedIndex} without changing other assignments`, () => {
    const original = [1, 2, 3].map((index) => ({
      index, product_id: index, price: 10000 + index * 1000,
      active: true, wayne_code: 16 + index, wayne_product_code: index,
    }));
    // The same list can be an unsaved draft or a catalog reloaded after saving.
    const remaining = original.filter((nozzle) => nozzle.index !== removedIndex);
    const before = structuredClone(remaining);
    const replacement = {
      index: nextAvailableNozzleIndex(remaining), product_id: 4,
      price: 14000, active: true, wayne_code: 0, wayne_product_code: 0,
    };
    assert.equal(replacement.index, removedIndex);
    assert.deepEqual(remaining, before);
    assert.equal(nextAvailableNozzleIndex([...remaining, replacement]), 4);
  });
}

test("starts at nozzle 1 and appends when no slots are missing", () => {
  assert.equal(nextAvailableNozzleIndex([]), 1);
  assert.equal(nextAvailableNozzleIndex([{ index: 1 }, { index: 2 }]), 3);
});

test("reserves inactive nozzles and finds the first gap in an unsorted list", () => {
  assert.equal(nextAvailableNozzleIndex([
    { index: 4, active: true },
    { index: 1, active: false },
    { index: 3, active: true },
  ]), 2);
});

test("reuses gaps at capacity and never allocates outside the u8 index range", () => {
  const full = Array.from({ length: 255 }, (_, i) => ({ index: i + 1 }));
  assert.equal(nextAvailableNozzleIndex(full), null);
  assert.equal(nextAvailableNozzleIndex(full.filter((nozzle) => nozzle.index !== 1)), 1);
  assert.equal(nextAvailableNozzleIndex(full.filter((nozzle) => nozzle.index !== 255)), 255);
});
