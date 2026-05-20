export interface SimDispenserInfo {
  fp_id: string;
  addr: number;
  label: string;
  status: string;
  volume: number;
  amount: number;
  respond: boolean;
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
  active: boolean;
  nozzles: NozzleSnapshot[];
}

export interface SiteLayout {
  site_name: string;
  positions: FpSnapshot[];
}

export const SCENARIOS = [
  { id: "normal_fill", label: "Normal fill" },
  { id: "emergency_stop", label: "Emergency stop" },
  { id: "two_simultaneous", label: "Two simultaneous" },
  { id: "ghost_fill", label: "Ghost fill" },
  { id: "long_disconnect", label: "Long disconnect" },
  { id: "all_scenarios", label: "All scenarios" },
] as const;
