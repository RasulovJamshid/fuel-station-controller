import type { NozzleSnapshot, SiteSnapshot } from "./types/api";

export interface PreAuthNozzleMismatchInfo {
  fpId: string;
  expectedProductName: string;
  liftedProductName: string;
  expectedColor: string;
  liftedColor: string;
}

const DEFAULT_COLOR = "#64748b";

const LEGACY_SIM_ERROR =
  /wrong nozzle for pre-auth: expected nozzle \d+ \(product (\d+)\).*got nozzle \d+ \(product (\d+)\)/i;

const FRIENDLY_SIM_ERROR =
  /wrong fuel grade: this sale is for ([^,]+), not ([^.]+)/i;

function colorForProduct(snapshot: SiteSnapshot | null, productName: string): string {
  const fromSite = snapshot?.products.find((p) => p.name === productName)?.color;
  return fromSite ?? DEFAULT_COLOR;
}

function colorFromNozzles(nozzles: NozzleSnapshot[], productName: string): string {
  const n = nozzles.find((nz) => nz.product_name === productName);
  return n?.product_color ?? DEFAULT_COLOR;
}

export function buildPreAuthNozzleMismatch(
  fpId: string,
  expectedProductName: string,
  liftedProductName: string,
  nozzles: NozzleSnapshot[],
  siteSnapshot: SiteSnapshot | null,
): PreAuthNozzleMismatchInfo {
  return {
    fpId,
    expectedProductName,
    liftedProductName,
    expectedColor:
      colorFromNozzles(nozzles, expectedProductName) ||
      colorForProduct(siteSnapshot, expectedProductName),
    liftedColor:
      colorFromNozzles(nozzles, liftedProductName) ||
      colorForProduct(siteSnapshot, liftedProductName),
  };
}

export function tryParseFriendlyPreAuthSimError(
  message: string,
  fpId: string,
  nozzles: NozzleSnapshot[],
  siteSnapshot: SiteSnapshot | null,
): PreAuthNozzleMismatchInfo | null {
  const m = message.match(FRIENDLY_SIM_ERROR);
  if (!m) return null;
  const expectedProductName = m[1]!.trim();
  const liftedProductName = m[2]!.trim();
  return buildPreAuthNozzleMismatch(
    fpId,
    expectedProductName,
    liftedProductName,
    nozzles,
    siteSnapshot,
  );
}

export function tryParseLegacyPreAuthSimError(
  message: string,
  fpId: string,
  nozzles: NozzleSnapshot[],
  siteSnapshot: SiteSnapshot | null,
): PreAuthNozzleMismatchInfo | null {
  const m = message.match(LEGACY_SIM_ERROR);
  if (!m) return null;
  const expectedId = Number(m[1]);
  const liftedId = Number(m[2]);
  const nameFor = (id: number) =>
    nozzles.find((nz) => nz.product_id === id)?.product_name ??
    siteSnapshot?.products.find((p) => p.id === id)?.name ??
    `Product ${id}`;
  return buildPreAuthNozzleMismatch(
    fpId,
    nameFor(expectedId),
    nameFor(liftedId),
    nozzles,
    siteSnapshot,
  );
}

export function isPreAuthNozzleMismatchError(message: string): boolean {
  return (
    LEGACY_SIM_ERROR.test(message) ||
    message.toLowerCase().includes("wrong fuel grade") ||
    message.toLowerCase().includes("wrong nozzle for pre-auth")
  );
}
