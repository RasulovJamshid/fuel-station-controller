// Preserve fields the form does not edit, including protocol extensions and UUIDs.
export type ConfigRecord = Record<string, any>;

export const protocolPresets: Record<string, { baud_rate: number; parity: string }> = {
  mock: { baud_rate: 9600, parity: 'none' },
  wayne_europump: { baud_rate: 9600, parity: 'odd' },
  wayne_dart_v1: { baud_rate: 9600, parity: 'odd' },
  wayne_dart_v2: { baud_rate: 9600, parity: 'odd' },
  gilbarco: { baud_rate: 9600, parity: 'even' },
  azt2_0: { baud_rate: 4800, parity: 'none' },
  texnouz_bluesky: { baud_rate: 9600, parity: 'even' },
  shelf_v2_2: { baud_rate: 19200, parity: 'none' },
};

export const protocolNames: Record<string, string> = {
  mock: 'Mock', wayne_europump: 'Wayne Europump', wayne_dart_v1: 'Wayne Dart V1',
  wayne_dart_v2: 'Wayne Dart V2', gilbarco: 'Gilbarco', azt2_0: 'AZT 2.0',
  texnouz_bluesky: 'TexnoUz BlueSky', shelf_v2_2: 'SHELF V2.2',
};

export function copySiteSetup(source: ConfigRecord, target: ConfigRecord): ConfigRecord {
  const copy = JSON.parse(JSON.stringify(source));
  // Credentials and station identity always belong to the destination.
  copy.site = { ...target.site };
  copy.sync = { ...copy.sync, enabled: target.sync.enabled, backend_url: target.sync.backend_url, api_key: target.sync.api_key };
  copy.tanks = (copy.tanks ?? []).map((tank: ConfigRecord) => ({ ...tank, current_l: 0 }));
  if (copy.atg) copy.atg.auth = null;
  return copy;
}

export function nextNumber(rows: ConfigRecord[], key: string, max = 255): number {
  const used = new Set(rows.map(row => row[key]));
  for (let n = 1; n <= max; n++) if (!used.has(n)) return n;
  return max + 1; // The server rejects exhaustion instead of silently reusing an ID.
}

export function configErrorMessage(error: any, fallback: string): string {
  const message = error?.response?.data?.message;
  return Array.isArray(message) ? message.join('\n') : typeof message === 'string' ? message : fallback;
}

export function downloadConfig(config: ConfigRecord, stationId: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `site.${stationId}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
