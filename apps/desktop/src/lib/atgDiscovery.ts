import type { AtgBranchInfo, AtgConfigSnapshot } from '../types/api';

export type AtgScanDevice = {
  host: string;
  error?: string;
  tanks: { slot: number; product_volume: number; temperature_c: number; water_volume: number }[];
};

export type AtgTankSelection = {
  host: string;
  slot: number;
  tank_id?: string;
  label: string;
  product_id: number;
  capacity_l: number;
};

function probeAddress(branch: AtgBranchInfo, slot: number): number {
  return branch.start_register - branch.address_base + (slot - 1) * 12;
}

export function scannedSlotMapping(config: AtgConfigSnapshot, profile: AtgBranchInfo, host: string, slot: number) {
  for (const branch of config.branches) {
    if (branch.host.trim() !== host.trim() || branch.port !== profile.port || branch.unit_id !== profile.unit_id) continue;
    const existing = branch.slots.find(s => probeAddress(branch, s.slot) === probeAddress(profile, slot));
    if (existing) return existing;
  }
  return undefined;
}

/** Apply only selected probes. Names never become physical tank identifiers. */
export function addScannedTanks(
  config: AtgConfigSnapshot,
  profile: AtgBranchInfo,
  selections: AtgTankSelection[],
  products: { id: number; name: string }[],
  newId = () => crypto.randomUUID(),
): AtgConfigSnapshot {
  const next: AtgConfigSnapshot = {
    ...config,
    tanks: config.tanks.map(t => ({ ...t })),
    branches: config.branches.map(b => ({ ...b, slots: b.slots.map(s => ({ ...s })) })),
  };
  for (const selection of selections) {
    if (scannedSlotMapping(next, profile, selection.host, selection.slot)) continue;
    const product = products.find(p => p.id === selection.product_id);
    if (!selection.host.trim() || !Number.isInteger(selection.slot) || selection.slot < 1 || selection.slot * 12 > profile.register_count
      || !selection.label.trim() || !product || !Number.isFinite(selection.capacity_l) || selection.capacity_l <= 0) {
      throw new Error('invalidSelection');
    }
    let tank = selection.tank_id ? next.tanks.find(t => t.tank_id === selection.tank_id) : undefined;
    if (selection.tank_id && (!tank || tank.product_id !== selection.product_id
      || next.branches.some(b => b.slots.some(s => s.tank_id === tank!.tank_id)))) throw new Error('tankAlreadyMapped');
    if (tank && tank.current_l > selection.capacity_l) throw new Error('invalidSelection');
    if (!tank) {
      tank = { tank_id: newId(), product_id: product.id, label: selection.label.trim(), capacity_l: selection.capacity_l, current_l: 0 };
      next.tanks.push(tank);
    } else {
      tank.label = selection.label.trim();
      tank.capacity_l = selection.capacity_l;
    }
    let branch = next.branches.find(b => b.host.trim() === selection.host.trim() && b.port === profile.port
      && b.unit_id === profile.unit_id && b.start_register === profile.start_register && b.address_base === profile.address_base
      && (b.word_order ?? 'ABCD') === (profile.word_order ?? 'ABCD') && (b.height_unit ?? 'mm') === (profile.height_unit ?? 'mm'));
    if (!branch) {
      // A scan must never move existing mappings to another controller.
      branch = next.branches.find(b => b.id === profile.id && b.slots.length === 0);
      if (branch) branch.host = selection.host;
      else {
        let id = 1;
        while (next.branches.some(b => b.id === id)) id++;
        branch = { ...profile, id, host: selection.host, name: selection.host, external_station_id: profile.external_station_id ?? profile.id, slots: [] };
        next.branches.push(branch);
      }
    }
    branch.register_count = Math.max(branch.register_count, selection.slot * 12);
    branch.slots.push({ slot: selection.slot, tank_id: tank.tank_id, product_id: product.id, type: product.name });
  }
  return next;
}
