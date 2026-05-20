/** Mirrors `types` crate JSON from dispenser-service. */

import type { FpStatus, StopSource } from "../lib/fpStatus";
import type { TxStatus } from "../lib/txStatus";

export type { FpStatus, FpStatusTag, PausedInfo, StopSource } from "../lib/fpStatus";
export { pausedInfo, statusTag } from "../lib/fpStatus";
export type { TxStatus } from "../lib/txStatus";
export { txStatusLabel, txStatusParentId } from "../lib/txStatus";

export type AuthMode = "preauth" | "reactive";

export type ShiftMode = "disabled" | "manual" | "scheduled";

export type ShiftStatus = "ACTIVE" | "CLOSED";

export interface FpState {
  fp_id: string;
  label: string;
  address_byte: number;
  status: FpStatus;
  volume: number;
  amount: number;
  price: number;
  nozzle_index: number | null;
  product_id: number | null;
  product_name: string | null;
  product_color: string | null;
  nozzle_count: number;
  seq: number;
  missed_polls: number;
  updated_at: number;
  stopped_tx_id?: string | null;
  base_volume?: number | null;
  base_amount?: number | null;
  segment_volume?: number | null;
  segment_amount?: number | null;
  pre_auth_preset?: string | null;
  stop_source?: StopSource | null;
}

export interface NozzleSnapshot {
  index: number;
  product_id: number;
  product_name: string;
  product_color: string;
  price: number;
  active: boolean;
}

export interface FpSnapshot {
  fp_id: string;
  label: string;
  address_byte: number;
  active: boolean;
  nozzles: NozzleSnapshot[];
}

export interface ShiftSlot {
  name: string;
  start: string;
  end: string;
}

export interface SiteSnapshot {
  site_id: string;
  site_name: string;
  protocol: string;
  positions: FpSnapshot[];
  products: { id: number; name: string; color: string; unit: string }[];
  shift_mode?: ShiftMode;
  shift_schedule?: ShiftSlot[];
  require_operator_pin?: boolean;
  default_auth_mode?: AuthMode;
  preauth_timeout_seconds?: number;
}

export interface ShiftPositionTotal {
  fp_id: string;
  label: string;
  transactions_count: number;
  total_volume: number;
  total_amount: number;
}

export interface Shift {
  id: string;
  operator_id: string | null;
  operator_name: string;
  shift_name: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  started_at: number;
  ended_at: number | null;
  total_transactions: number;
  total_volume: number;
  total_amount: number;
  status: ShiftStatus;
  notes: string | null;
  position_totals: ShiftPositionTotal[];
}

export interface StartShiftCmd {
  operator_name: string;
  pin?: string;
  notes?: string;
}

export interface EndShiftCmd {
  shift_id: string;
  notes?: string;
}

export interface HandoverCmd {
  outgoing_shift_id: string;
  incoming_operator: string;
  incoming_pin?: string;
  notes?: string;
}

export interface Transaction {
  id: string;
  fp_id: string;
  label: string;
  address_byte: number;
  started_at: number;
  completed_at: number | null;
  volume: number;
  amount: number;
  price: number;
  nozzle_index: number;
  product_id: number;
  product_name: string;
  status: TxStatus;
  shift_id?: string | null;
  operator_name?: string | null;
  parent_tx_id?: string | null;
  combined_volume?: number;
  combined_amount?: number;
}

/** WebSocket payloads: `event` + `data` (see `types::WsEvent`). */
export type WsEvent =
  | { event: "fp.status"; data: FpState }
  | {
      event: "fp.nozzle_up";
      data: {
        fp_id: string;
        nozzle_index: number;
        product_id: number;
        product_name: string;
        product_color: string;
        price: number;
      };
    }
  | { event: "fp.done"; data: Transaction }
  | {
      event: "fp.pre_authorized";
      data: {
        fp_id: string;
        price: number;
        preset: string;
        nozzle_index: number;
      };
    }
  | { event: "fp.pre_auth_cancelled"; data: { fp_id: string } }
  | {
      event: "fp.pre_auth_nozzle_mismatch";
      data: {
        fp_id: string;
        expected_nozzle_index: number;
        expected_product_name: string;
        lifted_nozzle_index: number;
        lifted_product_name: string;
      };
    }
  | {
      event: "fp.nozzle_removed";
      data: { fp_id: string; stopped_tx_id: string | null };
    }
  | { event: "fp.pre_auth_timeout"; data: { fp_id: string } }
  | {
      event: "fp.paused";
      data: {
        fp_id: string;
        stopped_volume: number;
        stopped_amount: number;
        stopped_tx_id: string;
        stop_source: StopSource;
      };
    }
  | { event: "fp.offline"; data: { fp_id: string; label: string } }
  | { event: "fp.online"; data: { fp_id: string; label: string } }
  | {
      event: "service.connected";
      data: { site_name: string; fp_count: number; protocol: string };
    }
  | {
      event: "service.price_updated";
      data: {
        fp_id: string;
        nozzle_index: number;
        product_name: string;
        old_price: number;
        new_price: number;
        changed_by: string;
      };
    }
  | { event: "shift.started"; data: Shift }
  | { event: "shift.ended"; data: Shift }
  | { event: "shift.handover"; data: { outgoing: Shift; incoming: Shift } }
  | { event: "shift.warning"; data: { shift_id: string; minutes_remaining: number } };

export interface AdminPriceEntry {
  fp_id: string;
  label: string;
  nozzle_index: number;
  product_id: number;
  product_name: string;
  price: number;
}

export interface PriceChange {
  id: string;
  fp_id: string;
  nozzle_index: number;
  product_id: number;
  product_name: string;
  old_price: number;
  new_price: number;
  changed_at: number;
  changed_by: string;
}

export interface Operator {
  id: string;
  name: string;
  has_pin: boolean;
  active: boolean;
  created_at: number;
}

export interface AdminSettingsSnapshot {
  polling_interval_ms: number;
  polling_offline_threshold_polls: number;
  preauth_timeout_seconds: number;
  shifts_warn_before_end_minutes: number;
  shift_mode: string;
  shift_schedule: ShiftSlot[];
}

export interface UpdatePriceCmd {
  fp_id: string;
  nozzle_index: number;
  price: number;
}

export interface AdminCatalog {
  products: { id: number; name: string; color: string; unit: string }[];
  positions: AdminPositionCatalog[];
}

export interface AdminPositionCatalog {
  fp_id: string;
  label: string;
  address_byte: number;
  active: boolean;
  nozzles: AdminNozzleRow[];
}

export interface AdminNozzleRow {
  index: number;
  product_id: number;
  product_name: string;
  price: number;
  active: boolean;
}

export interface AdminProductInput {
  id?: number | null;
  name: string;
  color: string;
  unit: string;
}

export interface AdminNozzleInput {
  index: number;
  product_id: number;
  price: number;
  active: boolean;
}
