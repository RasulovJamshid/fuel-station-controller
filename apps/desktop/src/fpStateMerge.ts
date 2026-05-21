import type { FpState } from "./types/api";
import { statusTag } from "./types/api";

const DONE_DISPLAY_HOLD_MS = 12_000;

/** Merge service status into store row (preserves pre-auth across reactive flicker). */
export function mergeIncomingFpState(
  prev: FpState | undefined,
  incoming: FpState,
  holdDoneUntil: Record<string, number> = {},
): FpState {
  if (!prev) return incoming;

  // Guard against stale poll responses reverting a WS-driven reconnect.
  // If we'd downgrade from an online state to OFFLINE, only allow it when the
  // incoming timestamp is strictly newer than what we already hold.
  if (
    statusTag(incoming.status) === "OFFLINE" &&
    statusTag(prev.status) !== "OFFLINE" &&
    incoming.updated_at <= prev.updated_at
  ) {
    return prev;
  }

  const incomingTag = statusTag(incoming.status);
  const prevTag = statusTag(prev.status);

  // Hose holstered: always accept IDLE from the service over a stale active row.
  if (
    incomingTag === "IDLE" &&
    (prevTag === "NOZZLE_UP" || prevTag === "AUTHORIZING" || prevTag === "DELIVERING")
  ) {
    return {
      ...incoming,
      nozzle_index: incoming.nozzle_index ?? null,
      product_id: incoming.product_id ?? null,
      product_name: incoming.product_name ?? null,
      product_color: incoming.product_color ?? null,
      pre_auth_preset: null,
    };
  }

  // Physical lift: always show NOZZLE_UP unless the lane is already in PRE_AUTHORIZED
  // (holstered pre-auth — brief status flicker only). Stale pre_auth_preset on IDLE
  // must not hide the lift.
  if (incomingTag === "NOZZLE_UP") {
    const keepPreAuth =
      prevTag === "PRE_AUTHORIZED" &&
      (incoming.pre_auth_preset ?? prev.pre_auth_preset) != null;
    return {
      ...incoming,
      status: keepPreAuth ? "PRE_AUTHORIZED" : incoming.status,
      pre_auth_preset: keepPreAuth
        ? (incoming.pre_auth_preset ?? prev.pre_auth_preset ?? null)
        : null,
      // New session after preauth: always show zero until live meter data arrives.
      volume: keepPreAuth ? 0 : incoming.volume,
      amount: keepPreAuth ? 0 : incoming.amount,
      base_volume: keepPreAuth ? null : incoming.base_volume,
      base_amount: keepPreAuth ? null : incoming.base_amount,
      segment_volume: keepPreAuth ? null : incoming.segment_volume,
      segment_amount: keepPreAuth ? null : incoming.segment_amount,
    };
  }

  // Preauth lift → authorizing: accept zero meters; do not keep a completed sale on screen.
  if (
    (incomingTag === "AUTHORIZING" || incomingTag === "DELIVERING") &&
    (prevTag === "PRE_AUTHORIZED" || prevTag === "NOZZLE_UP" || prev.pre_auth_preset != null) &&
    incoming.volume === 0 &&
    incoming.amount === 0
  ) {
    return {
      ...incoming,
      pre_auth_preset: incoming.pre_auth_preset ?? prev.pre_auth_preset ?? null,
      base_volume: null,
      base_amount: null,
      segment_volume: null,
      segment_amount: null,
    };
  }

  const clearPreAuthPreset =
    incomingTag === "DONE" ||
    incomingTag === "OFFLINE" ||
    (incomingTag === "IDLE" && incoming.pre_auth_preset == null);

  const preAuthPreset = clearPreAuthPreset
    ? (incoming.pre_auth_preset ?? null)
    : (incoming.pre_auth_preset ?? prev.pre_auth_preset ?? null);

  // Only heal when the service still reports an active pre-auth (not after cancel).
  const healPreAuthorizedIdle =
    incomingTag === "IDLE" &&
    incoming.pre_auth_preset != null &&
    prevTag !== "AUTHORIZING" &&
    prevTag !== "DELIVERING" &&
    prevTag === "PRE_AUTHORIZED";

  const keepPreAuthWhileHolstered = healPreAuthorizedIdle;

  const status = keepPreAuthWhileHolstered ? "PRE_AUTHORIZED" : incoming.status;

  const holdDone =
    prevTag === "DONE" &&
    incomingTag === "IDLE" &&
    incoming.volume === 0 &&
    prev.volume > 0 &&
    (holdDoneUntil[incoming.fp_id] ?? 0) > Date.now();

  return {
    ...incoming,
    status: holdDone ? prev.status : status,
    volume: holdDone ? prev.volume : incoming.volume,
    amount: holdDone ? prev.amount : incoming.amount,
    product_name: holdDone ? (prev.product_name ?? incoming.product_name) : (incoming.product_name ?? prev.product_name),
    product_id: holdDone ? (prev.product_id ?? incoming.product_id) : (incoming.product_id ?? prev.product_id),
    product_color: holdDone ? (prev.product_color ?? incoming.product_color) : (incoming.product_color ?? prev.product_color),
    nozzle_index: holdDone ? (prev.nozzle_index ?? incoming.nozzle_index) : (incoming.nozzle_index ?? prev.nozzle_index),
    pre_auth_preset: preAuthPreset,
    stopped_tx_id:
      incoming.stopped_tx_id ?? (incomingTag === "STOPPED" ? prev.stopped_tx_id : null) ?? null,
    stop_source:
      incoming.stop_source ?? (incomingTag === "STOPPED" ? prev.stop_source : null) ?? null,
  };
}

export function mergeIncomingFpStates(
  prevRows: FpState[],
  incomingRows: FpState[],
  holdDoneUntil: Record<string, number> = {},
): FpState[] {
  return incomingRows.map((incoming) => {
    const prev = prevRows.find((s) => s.fp_id === incoming.fp_id);
    return mergeIncomingFpState(prev, incoming, holdDoneUntil);
  });
}

export { DONE_DISPLAY_HOLD_MS };
