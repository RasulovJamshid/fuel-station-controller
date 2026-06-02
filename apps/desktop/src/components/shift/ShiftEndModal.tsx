import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Shift } from "../../types/api";

type Props = {
  open: boolean;
  shift: Shift | null;
  onClose: () => void;
  onConfirm: (shiftId: string, notes?: string) => Promise<void>;
};

export function ShiftEndModal({ open, shift, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open || !shift) return null;

  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm(shift.id, notes.trim() || undefined);
      setNotes("");
    } finally {
      setBusy(false);
    }
  };

  const closeDesc = shift.shift_name
    ? t("shiftEnd.withShiftName", { name: shift.operator_name, shiftName: shift.shift_name })
    : t("shiftEnd.closeFor", { name: shift.operator_name });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-white">{t("shiftEnd.title")}</h2>
        <p className="text-sm text-slate-400">{closeDesc}</p>
        <div>
          <label className="mb-1 block text-xs text-slate-400">{t("shiftEnd.notes")}</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
            placeholder={t("shiftEnd.notesPlaceholder")}
          />
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-lg border border-slate-600 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            {t("shiftEnd.cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="flex-1 rounded-lg bg-red-800 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
          >
            {t("shiftEnd.end")}
          </button>
        </div>
      </div>
    </div>
  );
}
