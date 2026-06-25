export function formatMoney(value: number | string | null | undefined): string {
  if (value == null || value === "") return "";
  const raw = typeof value === "number" ? String(Math.trunc(value)) : value;
  const digits = raw.replace(/[^\d-]/g, "");
  if (digits === "" || digits === "-") return raw;
  const sign = digits.startsWith("-") ? "-" : "";
  const body = sign ? digits.slice(1) : digits;
  return `${sign}${body.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;
}

export function parseMoney(value: string | number | null | undefined): number {
  if (typeof value === "number") return value;
  if (value == null) return 0;
  const normalized = value.replace(/\s/g, "").replace(/[^\d.-]/g, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatMoneyInput(value: string | number | null | undefined): string {
  return formatMoney(value);
}
