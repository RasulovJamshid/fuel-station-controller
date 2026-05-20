import type { FpState } from "./types/api";
import { statusTag } from "./types/api";

const DEFAULT_POLL_MS = 200;
const DEFAULT_TIMEOUT_MS = 2500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Poll dispenser-service until lane status changes or timeout (serial poll is ~200ms). */
export async function waitForFpStatusChange(
  fpId: string,
  statusBefore: string,
  invokeGetStatus: () => Promise<FpState[]>,
  options?: { pollMs?: number; timeoutMs?: number },
): Promise<FpState | undefined> {
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let latest: FpState | undefined;
  while (Date.now() < deadline) {
    const rows = await invokeGetStatus();
    latest = rows.find((s) => s.fp_id === fpId);
    if (latest) {
      const tag =
        typeof latest.status === "object" && latest.status !== null && "STOPPED" in latest.status
          ? "STOPPED"
          : String(latest.status);
      if (tag !== statusBefore) {
        return latest;
      }
    }
    await sleep(pollMs);
  }
  return latest;
}

/** After POST preauthorize, wait until dispenser-service reports PRE_AUTHORIZED. */
export async function waitForPreAuthorized(
  fpId: string,
  invokeGetStatus: () => Promise<FpState[]>,
  options?: { pollMs?: number; timeoutMs?: number },
): Promise<FpState | undefined> {
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let latest: FpState | undefined;
  while (Date.now() < deadline) {
    const rows = await invokeGetStatus();
    latest = rows.find((s) => s.fp_id === fpId);
    if (latest && statusTag(latest.status) === "PRE_AUTHORIZED") {
      return latest;
    }
    await sleep(pollMs);
  }
  return latest;
}

/** After pre-auth, wait until the sale actually starts — not reactive NOZZLE_UP. */
export async function waitForPreAuthLift(
  fpId: string,
  invokeGetStatus: () => Promise<FpState[]>,
  options?: { pollMs?: number; timeoutMs?: number },
): Promise<FpState | undefined> {
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let latest: FpState | undefined;
  while (Date.now() < deadline) {
    const rows = await invokeGetStatus();
    latest = rows.find((s) => s.fp_id === fpId);
    if (latest) {
      const tag = statusTag(latest.status);
      if (tag === "AUTHORIZING" || tag === "DELIVERING") {
        return latest;
      }
    }
    await sleep(pollMs);
  }
  return latest;
}

export async function refreshFpStatus(
  invokeGetStatus: () => Promise<FpState[]>,
  options?: { pollMs?: number; rounds?: number },
): Promise<FpState[]> {
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const rounds = options?.rounds ?? 3;
  let rows: FpState[] = [];
  for (let i = 0; i < rounds; i += 1) {
    rows = await invokeGetStatus();
    if (i + 1 < rounds) await sleep(pollMs);
  }
  return rows;
}
