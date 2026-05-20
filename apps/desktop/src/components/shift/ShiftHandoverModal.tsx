import { useState } from "react";
import type { HandoverCmd, Shift } from "../../types/api";

type Props = {
  open: boolean;
  outgoingShift: Shift | null;
  requirePin: boolean;
  onClose: () => void;
  onConfirm: (cmd: HandoverCmd) => Promise<void>;
};

export function ShiftHandoverModal({
  open,
  outgoingShift,
  requirePin,
  onClose,
  onConfirm,
}: Props) {
  const [incomingName, setIncomingName] = useState("");
  const [incomingPin, setIncomingPin] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open || !outgoingShift) return null;

  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm({
        outgoing_shift_id: outgoingShift.id,
        incoming_operator: incomingName.trim(),
        incoming_pin: requirePin ? incomingPin : incomingPin || undefined,
        notes: notes.trim() || undefined,
      });
      setIncomingName("");
      setIncomingPin("");
      setNotes("");
    } finally {
      setBusy(false);
    }
  };

  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-white">Shift handover</h2>

        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Outgoing summary
          </div>
          <div className="mt-1 text-sm font-medium text-slate-100">
            {outgoingShift.operator_name}
            {outgoingShift.shift_name ? (
              <span className="ml-2 text-slate-400">{outgoingShift.shift_name}</span>
            ) : null}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-xs text-slate-500">Transactions</div>
              <div className="font-mono text-sm text-white">
                {outgoingShift.total_transactions}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Volume</div>
              <div className="font-mono text-sm text-white">
                {fmt.format(outgoingShift.total_volume)} L
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Amount</div>
              <div className="font-mono text-sm text-white">
                {outgoingShift.total_amount.toLocaleString()}
              </div>
            </div>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs text-slate-400">Incoming operator</label>
          <input
            value={incomingName}
            onChange={(e) => setIncomingName(e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
            placeholder="Incoming operator name"
            autoFocus
          />
        </div>

        {requirePin ? (
          <div>
            <label className="mb-1 block text-xs text-slate-400">Incoming PIN</label>
            <input
              type="password"
              value={incomingPin}
              onChange={(e) => setIncomingPin(e.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
              placeholder="••••"
            />
          </div>
        ) : null}

        <div>
          <label className="mb-1 block text-xs text-slate-400">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
            placeholder="Handover notes…"
          />
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-lg border border-slate-600 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!incomingName.trim() || busy}
            onClick={() => void submit()}
            className="flex-1 rounded-lg bg-sky-700 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-40"
          >
            Confirm handover
          </button>
        </div>
      </div>
    </div>
  );
}
