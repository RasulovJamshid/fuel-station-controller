import { useEffect, useState } from "react";
import type { FpState } from "../types/api";

export function useDispenserState(fpId: string, states: FpState[]) {
  const [local, setLocal] = useState<FpState | undefined>();
  useEffect(() => {
    setLocal(states.find((s) => s.fp_id === fpId));
  }, [fpId, states]);
  return local;
}
