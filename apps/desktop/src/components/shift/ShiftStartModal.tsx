import { useState } from "react";
import type { StartShiftCmd } from "../../types/api";

type Props = {
  open: boolean;
  requirePin: boolean;
  onClose: () => void;
  onConfirm: (cmd: StartShiftCmd) => Promise<void>;
};

export function ShiftStartModal({ open, requirePin, onClose, onConfirm }: Props) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm({
        operator_name: name.trim(),
        pin: requirePin ? pin : pin || undefined,
      });
      setName("");
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-white">Start shift</h2>
        <div>
          <label className="mb-1 block text-xs text-slate-400">Operator name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
            placeholder="Your name"
            autoFocus
          />
        </div>
        {requirePin ? (
          <div>
            <label className="mb-1 block text-xs text-slate-400">PIN</label>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
              placeholder="••••"
            />
          </div>
        ) : null}
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
            disabled={!name.trim() || busy}
            onClick={() => void submit()}
            className="flex-1 rounded-lg bg-emerald-700 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            Start shift
          </button>
        </div>
      </div>
    </div>
  );
}
