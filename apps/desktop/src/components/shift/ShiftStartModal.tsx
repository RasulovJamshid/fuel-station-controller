import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { StartShiftCmd } from "../../types/api";

type Props = {
  open: boolean;
  requirePin: boolean;
  onClose: () => void;
  onConfirm: (cmd: StartShiftCmd) => Promise<void>;
};

/** Format a Date to the value required by <input type="datetime-local">. */
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function ShiftStartModal({ open, requirePin, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  const [name, setName]           = useState("");
  const [pin, setPin]             = useState("");
  const [notes, setNotes]         = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [startedAt, setStartedAt] = useState(() => toDatetimeLocal(new Date()));
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState<string | null>(null);

  if (!open) return null;

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const overrideMs = showAdvanced && startedAt
        ? new Date(startedAt).getTime()
        : undefined;

      await onConfirm({
        operator_name: name.trim(),
        pin: requirePin ? pin : pin || undefined,
        notes: notes.trim() || undefined,
        started_at_override: overrideMs,
      });
      setName("");
      setPin("");
      setNotes("");
      setStartedAt(toDatetimeLocal(new Date()));
      setShowAdvanced(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-white">{t("shiftStart.title")}</h2>

        {/* Operator name */}
        <div>
          <label className="mb-1 block text-sm text-slate-400">{t("shiftStart.operatorName")}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
            placeholder={t("shiftStart.operatorNamePlaceholder")}
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && !busy && name.trim() && void submit()}
          />
        </div>

        {/* PIN */}
        {requirePin ? (
          <div>
            <label className="mb-1 block text-sm text-slate-400">{t("shiftStart.pin")}</label>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
              placeholder="••••"
            />
          </div>
        ) : null}

        {/* Advanced toggle */}
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors"
        >
          <span className={`transition-transform duration-150 ${showAdvanced ? "rotate-90" : ""}`}>▶</span>
          {t("shiftStart.advanced")}
        </button>

        {showAdvanced && (
          <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-3">
            {/* Backdated start time */}
            <div>
              <label className="mb-1 block text-sm text-slate-400">{t("shiftStart.startedAt")}</label>
              <input
                type="datetime-local"
                value={startedAt}
                max={toDatetimeLocal(new Date())}
                onChange={(e) => setStartedAt(e.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
              />
              <p className="mt-1 text-xs text-slate-500">{t("shiftStart.startedAtHint")}</p>
            </div>

            {/* Notes */}
            <div>
              <label className="mb-1 block text-sm text-slate-400">{t("shiftStart.notes")}</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none resize-none"
                placeholder={t("shiftStart.notesPlaceholder")}
              />
            </div>
          </div>
        )}

        {err && (
          <p className="rounded-lg bg-red-900/40 px-3 py-2 text-sm text-red-300">{err}</p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-lg border border-slate-600 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            {t("shiftStart.cancel")}
          </button>
          <button
            type="button"
            disabled={!name.trim() || busy}
            onClick={() => void submit()}
            className="flex-1 rounded-lg bg-emerald-700 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            {busy ? "…" : t("shiftStart.start")}
          </button>
        </div>
      </div>
    </div>
  );
}
