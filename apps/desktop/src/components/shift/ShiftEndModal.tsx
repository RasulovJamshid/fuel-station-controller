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
  const [err, setErr] = useState<string | null>(null);

  if (!open || !shift) return null;

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await onConfirm(shift.id, notes.trim() || undefined);
      setNotes("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const closeDesc = shift.shift_name
    ? t("shiftEnd.withShiftName", { name: shift.operator_name, shiftName: shift.shift_name })
    : t("shiftEnd.closeFor", { name: shift.operator_name });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-border-primary bg-bg-card p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-text-primary">{t("shiftEnd.title")}</h2>
        <p className="text-sm text-text-secondary">{closeDesc}</p>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">{t("shiftEnd.notes")}</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
            placeholder={t("shiftEnd.notesPlaceholder")}
          />
        </div>
        {err && (
          <p className="rounded-lg bg-accent-red/10 px-3 py-2 text-sm text-accent-red-light">{err}</p>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-lg border border-border-primary py-2 text-sm text-text-secondary hover:bg-bg-secondary"
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
