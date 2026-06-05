/** Mirrors `types::TxStatus` JSON from dispenser-service. */

export type TxStatus =
  | "COMPLETED"
  | "ABORTED"
  | "STOPPED"
  | { CONTINUED_FROM: string };

export function txStatusLabel(status: TxStatus): string {
  if (typeof status === "string") return status;
  if (typeof status === "object" && status !== null && "CONTINUED_FROM" in status) {
    return "CONTINUED_FROM";
  }
  return "UNKNOWN";
}

/** Returns the i18n key for displaying a transaction status to the user. */
export function txStatusI18nKey(status: TxStatus): string {
  return `txStatus.${txStatusLabel(status)}`;
}

export function txStatusParentId(status: TxStatus): string | null {
  if (typeof status === "object" && status !== null && "CONTINUED_FROM" in status) {
    return status.CONTINUED_FROM;
  }
  return null;
}
