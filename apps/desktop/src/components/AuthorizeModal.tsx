import type { FpState, NozzleSnapshot } from "../types/api";
import type { AuthorizeRequest, FillMode } from "./DispenserCard";
import { SaleSetupPanel } from "./SaleSetupPanel";

type Props = {
  open: boolean;
  state: FpState;
  fpNozzles: NozzleSnapshot[];
  mode?: "preauth" | "reactive";
  initialNozzle?: number | null;
  initialFillMode?: FillMode;
  onClose: () => void;
  onConfirm: (req: AuthorizeRequest) => void;
};

export function AuthorizeModal({
  open,
  state,
  fpNozzles,
  mode = "reactive",
  initialNozzle = null,
  initialFillMode,
  onClose,
  onConfirm,
}: Props) {
  if (!open) return null;

  const activeNozzles = fpNozzles.filter((n) => n.active);
  const confirmLabel = mode === "preauth" ? "Pre-authorize" : "Authorize";
  const title = mode === "preauth" ? "Pre-authorize" : "Authorize";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-labelledby="authorize-modal-title"
        className="w-full max-w-lg overflow-hidden rounded-md border-2 bg-slate-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p id="authorize-modal-title" className="sr-only">
          {title} — Pump {state.fp_id}
        </p>
        <SaleSetupPanel
          key={`${state.fp_id}-${initialNozzle ?? "none"}-${initialFillMode ?? "full"}`}
          fpId={state.fp_id}
          activeNozzles={activeNozzles}
          initialNozzle={initialNozzle}
          initialFillMode={initialFillMode}
          title={title}
          subtitle="Choose product and fill limit"
          theme={mode === "preauth" ? "amber" : "emerald"}
          confirmLabel={confirmLabel}
          onConfirm={(req) => {
            onConfirm(req);
            onClose();
          }}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
