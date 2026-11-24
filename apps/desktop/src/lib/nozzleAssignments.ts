import type { AdminNozzleInput } from "../types/api";

export function nextAvailableNozzleIndex(
  nozzles: readonly Pick<AdminNozzleInput, "index">[],
): number | null {
  // Reuse deleted slots without renumbering the remaining physical nozzles.
  const used = new Set(nozzles.map((nozzle) => nozzle.index));
  for (let index = 1; index <= 255; index++) {
    if (!used.has(index)) return index;
  }
  return null;
}
