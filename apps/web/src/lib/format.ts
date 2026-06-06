export function fmtVolume(litres: number): string {
  if (litres >= 1000) return `${(litres / 1000).toFixed(2)} м³`;
  return `${litres.toFixed(1)} л`;
}

export function fmtMoney(tiyin: number | bigint): string {
  const sum = Number(tiyin) / 100;
  if (sum >= 1_000_000) return `${(sum / 1_000_000).toFixed(2)} млн сум`;
  return new Intl.NumberFormat('ru-UZ', { maximumFractionDigits: 0 }).format(sum) + ' сум';
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-UZ', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-UZ', {
    day: '2-digit', month: 'short',
  });
}

export function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин. назад`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ч. назад`;
  return `${Math.floor(hrs / 24)} д. назад`;
}

export function fmtDuration(startIso: string, endIso?: string | null): string {
  const end = endIso ? new Date(endIso) : new Date();
  const mins = Math.floor((end.getTime() - new Date(startIso).getTime()) / 60_000);
  if (mins < 60) return `${mins} мин`;
  return `${Math.floor(mins / 60)}ч ${mins % 60}м`;
}
