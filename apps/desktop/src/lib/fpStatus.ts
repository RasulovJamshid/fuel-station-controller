import type { FpState } from "../types/api";

export type StopSource = "APP" | "APP_FINAL" | "EXTERNAL";

export type FpStatusTag =
  | "OFFLINE"
  | "IDLE"
  | "PRE_AUTHORIZED"
  | "NOZZLE_UP"
  | "AUTHORIZING"
  | "DELIVERING"
  | "DONE"
  | "STOPPED";

/** JSON status: unit variant string or `STOPPED` struct from the service. */
export type FpStatus =
  | FpStatusTag
  | {
      STOPPED: {
        stopped_volume: number;
        stopped_amount: number;
        stopped_tx_id: string;
        stop_source: StopSource;
      };
    };

export interface PausedInfo {
  stopped_volume: number;
  stopped_amount: number;
  stopped_tx_id: string;
  stop_source: StopSource;
}

export function statusTag(status: FpStatus): FpStatusTag {
  if (typeof status === "string") return status;
  if (typeof status === "object" && status !== null && "STOPPED" in status) {
    return "STOPPED";
  }
  return "IDLE";
}

export function pausedInfo(state: FpState): PausedInfo | null {
  const s = state.status as FpStatus;
  if (typeof s === "object" && s !== null && "STOPPED" in s) {
    return s.STOPPED;
  }
  if (state.stopped_tx_id && state.stop_source) {
    return {
      stopped_tx_id: state.stopped_tx_id,
      stopped_volume: state.volume,
      stopped_amount: state.amount,
      stop_source: state.stop_source,
    };
  }
  return null;
}
