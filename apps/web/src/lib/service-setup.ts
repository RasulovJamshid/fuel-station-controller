import { ConfigRecord, nextNumber } from './service-config';

export type SetupIssue = { path: string; step: number; code: string; min?: number; max?: number };
export const tankId = (tank: ConfigRecord): string => tank.tank_id || (tank.product_id == null ? tank.label : String(tank.product_id));
export const hoseAddressKey = (protocol: string): string | undefined => ({
  azt2_0: 'azt_address', shelf_v2_2: 'shelf_address', texnouz_bluesky: 'bluesky_hose_number',
} as Record<string, string>)[protocol];

/** Freeze legacy identities before the user renames a tank or changes its product. */
export function prepareSetup(source: ConfigRecord): ConfigRecord {
  const config = JSON.parse(JSON.stringify(source));
  const slots: ConfigRecord[] = (config.atg?.branches ?? []).flatMap((b: ConfigRecord) => b.slots ?? []);
  config.tanks = (config.tanks ?? []).map((tank: ConfigRecord) => {
    const matches = slots.filter(s => tank.product_id != null && s.product_id === tank.product_id);
    return { ...tank, tank_id: tank.tank_id || (matches.length === 1 ? matches[0].tank_id || matches[0].label : '') || tankId(tank) };
  });
  for (const slot of slots) {
    if (!slot.tank_id && slot.product_id != null) {
      const matches = config.tanks.filter((t: ConfigRecord) => t.product_id === slot.product_id);
      if (matches.length === 1) slot.tank_id = matches[0].tank_id;
    }
  }
  return config;
}

export function assignNozzleTank(config: ConfigRecord, fpId: string, index: number, id: string): ConfigRecord {
  return { ...config, tanks: (config.tanks ?? []).map((tank: ConfigRecord) => {
    const sources = (tank.nozzle_sources ?? []).filter((s: ConfigRecord) => s.fp_id !== fpId || s.nozzle_index !== index);
    if (tankId(tank) === id) sources.push({ fp_id: fpId, nozzle_index: index });
    return { ...tank, nozzle_sources: sources };
  }) };
}

export function updatePosition(config: ConfigRecord, i: number, next: ConfigRecord): ConfigRecord {
  const old = config.fueling_positions[i];
  return { ...config,
    fueling_positions: config.fueling_positions.map((fp: ConfigRecord, j: number) => i === j ? next : fp),
    tanks: (config.tanks ?? []).map((t: ConfigRecord) => ({ ...t, nozzle_sources: (t.nozzle_sources ?? [])
      .filter((s: ConfigRecord) => s.fp_id !== old.id || next.nozzles.some((n: ConfigRecord) => n.index === s.nozzle_index))
      .map((s: ConfigRecord) => s.fp_id === old.id ? { ...s, fp_id: next.id } : s) })),
  };
}

export function updateNozzle(config: ConfigRecord, i: number, j: number, next: ConfigRecord): ConfigRecord {
  const fp = config.fueling_positions[i];
  const old = fp.nozzles[j];
  return { ...config,
    fueling_positions: config.fueling_positions.map((p: ConfigRecord, k: number) => k === i ? {
      ...fp, nozzles: fp.nozzles.map((n: ConfigRecord, k: number) => k === j ? next : n),
    } : p),
    tanks: (config.tanks ?? []).map((t: ConfigRecord) => ({ ...t, nozzle_sources: (t.nozzle_sources ?? []).map((s: ConfigRecord) =>
      s.fp_id === fp.id && s.nozzle_index === old.index ? { ...s, nozzle_index: next.index } : s) })),
  };
}

export function mapSensor(slot: ConfigRecord, tank: ConfigRecord, products: ConfigRecord[]): ConfigRecord {
  const maxima = { ...slot.maxima };
  delete maxima.product_volume;
  const next: ConfigRecord = { ...slot, tank_id: tankId(tank), product_id: tank.product_id ?? null,
    type: products.find(p => p.id === tank.product_id)?.name || tank.label, maxima };
  delete next.capacity_l;
  return next;
}

export function updateTank(config: ConfigRecord, index: number, next: ConfigRecord): ConfigRecord {
  const id = tankId(config.tanks[index]);
  return { ...config, tanks: config.tanks.map((tank: ConfigRecord, i: number) => i === index ? next : tank),
    atg: config.atg && { ...config.atg, branches: config.atg.branches.map((branch: ConfigRecord) => ({
      ...branch, slots: branch.slots.map((slot: ConfigRecord) => {
        if (slot.tank_id !== id) return slot;
        const updated: ConfigRecord = { ...slot, tank_id: tankId(next), product_id: next.product_id ?? null, maxima: { ...slot.maxima } };
        delete updated.capacity_l; delete updated.maxima.product_volume;
        return updated;
      }),
    })) },
  };
}

export function newSetupNozzle(config: ConfigRecord, nozzles: ConfigRecord[]): ConfigRecord {
  const index = nextNumber(nozzles, 'index');
  const key = hoseAddressKey(config.connection.protocol);
  const used = config.fueling_positions.flatMap((p: ConfigRecord) => p.nozzles.map((n: ConfigRecord) => ({
    address: key ? n[key] || (key === 'bluesky_hose_number' ? p.address_byte + n.index : p.address_byte) : 0,
  })));
  return { index, product_id: config.products[0]?.id ?? 1, price: 10000, active: true,
    ...(key ? { [key]: nextNumber(used, 'address', key === 'azt_address' ? 225 : 255) } : {}) };
}

/** Field paths are stable between validation, inline errors and review links. */
export function validateSetup(config: ConfigRecord): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const add = (path: string, step: number, code: string, bounds = {}) => issues.push({ path, step, code, ...bounds });
  const required = (value: any, path: string, step: number) => { if (typeof value !== 'string' || !value.trim()) add(path, step, 'required'); };
  const number = (value: any, path: string, step: number, min: number, max: number, integer = true) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) add(path, step, integer ? 'integerRange' : 'range', { min, max });
  };
  const unique = (rows: ConfigRecord[], key: string, path: string, step: number) => rows.forEach((r, i) => {
    if (rows.some((other, j) => i !== j && other[key] === r[key])) add(`${path}.${i}.${key}`, step, 'duplicate');
  });
  const connection = config.connection;
  const protocol = connection.protocol;
  required(connection.port, 'connection.port', 0);
  number(connection.baud_rate, 'connection.baud_rate', 0, 1, 4294967295);
  number(connection.data_bits, 'connection.data_bits', 0, 5, 8);
  number(connection.stop_bits, 'connection.stop_bits', 0, 1, 2);
  number(connection.response_timeout_ms, 'connection.response_timeout_ms', 0, 1, Number.MAX_SAFE_INTEGER);
  if (protocol === 'shelf_v2_2' && (connection.data_bits !== 8 || connection.parity !== 'none' || connection.stop_bits !== 1)) add('connection.parity', 0, 'shelfFormat');
  const products = config.products ?? [];
  if (!products.length) add('products', 4, 'productsRequired');
  unique(products, 'id', 'products', 4);
  products.forEach((p: ConfigRecord, i: number) => {
    number(p.id, `products.${i}.id`, 4, 0, 255);
    required(p.name, `products.${i}.name`, 4);
  });
  const productIds = new Set(products.map((p: ConfigRecord) => p.id));
  const positions = config.fueling_positions ?? [];
  if (!positions.length) add('fueling_positions', 1, 'pumpsRequired');
  unique(positions, 'id', 'fueling_positions', 1);
  const hoses = new Map<number, string>();
  const key = hoseAddressKey(protocol);
  positions.forEach((fp: ConfigRecord, i: number) => {
    const path = `fueling_positions.${i}`;
    required(fp.id, `${path}.id`, 1); required(fp.label, `${path}.label`, 1);
    number(fp.address_byte, `${path}.address_byte`, 1, protocol === 'shelf_v2_2' ? 1 : 0, 255);
    if (fp.active && positions.some((p: ConfigRecord, j: number) => i !== j && p.active && p.address_byte === fp.address_byte)) add(`${path}.address_byte`, 1, 'duplicate');
    if (fp.active && (!fp.nozzles.length || (protocol === 'shelf_v2_2' && !fp.nozzles.some((n: ConfigRecord) => n.active)))) add(`${path}.active`, 1, 'nozzlesRequired');
    unique(fp.nozzles, 'index', `${path}.nozzles`, 1);
    fp.nozzles.forEach((n: ConfigRecord, j: number) => {
      const np = `${path}.nozzles.${j}`;
      number(n.index, `${np}.index`, 1, 1, protocol === 'shelf_v2_2' && n.active ? 5 : 255);
      if (!productIds.has(n.product_id)) add(`${np}.product_id`, 4, 'unknownProduct');
      number(n.price, `${np}.price`, 4, n.active ? 1 : 0, protocol === 'shelf_v2_2' && n.active ? 65535 : 4294967295);
      if (protocol === 'azt2_0' && fp.active && n.active && (n.price > 99990 || n.price % 10)) add(`${np}.price`, 4, 'aztPrice');
      if (key) {
        number(n[key] ?? 0, `${np}.${key}`, 1, 0, key === 'azt_address' ? 225 : 255);
        if (fp.active && n.active) {
          const address = n[key] || (protocol === 'texnouz_bluesky' ? fp.address_byte + n.index : fp.address_byte);
          number(address, `${np}.${key}`, 1, 1, key === 'azt_address' ? 225 : 255);
          if (hoses.has(address)) { add(`${np}.${key}`, 1, 'duplicate'); add(hoses.get(address)!, 1, 'duplicate'); }
          hoses.set(address, `${np}.${key}`);
        }
      }
      if (protocol.startsWith('wayne')) for (const code of ['wayne_code', 'wayne_product_code']) number(n[code] ?? 0, `${np}.${code}`, 1, 0, 255);
    });
  });
  const tanks = config.tanks ?? [];
  const sources = new Set<string>();
  tanks.forEach((tank: ConfigRecord, i: number) => {
    const path = `tanks.${i}`;
    required(tank.label, `${path}.label`, 2);
    if (tanks.some((t: ConfigRecord, j: number) => j !== i && tankId(t) === tankId(tank))) add(`${path}.label`, 2, 'duplicateTank');
    number(tank.capacity_l, `${path}.capacity_l`, 2, 0.01, Number.MAX_SAFE_INTEGER, false);
    number(tank.current_l, `${path}.current_l`, 2, 0, tank.capacity_l, false);
    if (tank.product_id != null && !productIds.has(tank.product_id)) add(`${path}.product_id`, 2, 'unknownProduct');
    for (const source of tank.nozzle_sources ?? []) {
      const id = JSON.stringify([source.fp_id, source.nozzle_index]);
      if (sources.has(id) || !positions.some((p: ConfigRecord) => p.id === source.fp_id && p.nozzles.some((n: ConfigRecord) => n.index === source.nozzle_index))) add(`${path}.nozzle_sources`, 4, 'invalidSource');
      sources.add(id);
    }
  });
  const atg = config.atg;
  if (atg) {
    const branches = atg.branches ?? [];
    if (atg.enabled !== false && !branches.length) add('atg.enabled', 3, 'controllerRequired');
    number(atg.poll_interval_secs ?? 300, 'atg.poll_interval_secs', 3, 1, 86400);
    number(atg.modbus_timeout_secs ?? 10, 'atg.modbus_timeout_secs', 3, 0.1, 120, false);
    if (atg.stale_after_secs != null) number(atg.stale_after_secs, 'atg.stale_after_secs', 3, atg.poll_interval_secs ?? 300, 604800);
    unique(branches, 'id', 'atg.branches', 3);
    const mapped = new Set<string>(); const probes = new Set<string>();
    branches.forEach((b: ConfigRecord, i: number) => {
      const path = `atg.branches.${i}`;
      required(b.host, `${path}.host`, 3);
      number(b.port ?? 502, `${path}.port`, 3, 1, 65535);
      number(b.unit_id ?? 1, `${path}.unit_id`, 3, 0, 255);
      number(b.address_base ?? 1, `${path}.address_base`, 3, 0, 1);
      number(b.start_register ?? 1000, `${path}.start_register`, 3, b.address_base ?? 1, 65535);
      const start = (b.start_register ?? 1000) - (b.address_base ?? 1);
      number(b.register_count ?? 12, `${path}.register_count`, 3, 12, Math.min(65532, 65536 - start));
      if ((b.register_count ?? 12) % 12) add(`${path}.register_count`, 3, 'registerMultiple');
      if (!b.slots.length) add(`${path}.host`, 3, 'sensorRequired');
      unique(b.slots, 'slot', `${path}.slots`, 3);
      b.slots.forEach((slot: ConfigRecord, j: number) => {
        const sp = `${path}.slots.${j}`;
        number(slot.slot, `${sp}.slot`, 3, 1, Math.floor((b.register_count ?? 12) / 12));
        required(slot.type, `${sp}.type`, 3);
        // Standalone external-reporting slots remain supported in the full editor.
        if (slot.tank_id) {
          const tank = tanks.find((t: ConfigRecord) => tankId(t) === slot.tank_id);
          if (!tank && slot.product_id != null) add(`${sp}.tank_id`, 3, 'unknownTank');
          if (mapped.has(slot.tank_id)) add(`${sp}.tank_id`, 3, 'duplicateTank');
          mapped.add(slot.tank_id);
          if (tank && [slot.capacity_l, slot.maxima?.product_volume].some(v => v != null && Math.abs(v - tank.capacity_l) > 0.01)) add(`${sp}.tank_id`, 3, 'capacityConflict');
        } else if (slot.product_id != null && tanks.filter((t: ConfigRecord) => t.product_id === slot.product_id).length !== 1) add(`${sp}.tank_id`, 3, 'unknownTank');
        const probe = JSON.stringify([b.host?.trim(), b.port ?? 502, b.unit_id ?? 1, start + (slot.slot - 1) * 12]);
        if (probes.has(probe)) add(`${sp}.slot`, 3, 'duplicateProbe');
        probes.add(probe);
      });
    });
  }
  return issues;
}
