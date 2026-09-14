import { statusTag, type FpState } from "../types/api";

export function preAuthCancelWaitMessageKey(state: FpState): string | null {
  if (statusTag(state.status) !== "PRE_AUTHORIZED") return null;
  switch (state.pre_auth_cancel_wait) {
    case "AWAITING_STATUS": return "dispenser.cancelAwaitingStatus";
    case "KEYPAD_PRESET": return "dispenser.cancelAwaitingKeypad";
    default: return null;
  }
}
