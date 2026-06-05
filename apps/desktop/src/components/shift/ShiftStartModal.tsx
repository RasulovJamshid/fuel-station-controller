import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Operator, StartShiftCmd } from "../../types/api";

type Props = {
  open: boolean;
  requirePin: boolean;
  onClose: () => void;
  onConfirm: (cmd: StartShiftCmd) => Promise<void>;
};

function floorTo5(m: number): number {
  return Math.floor(m / 5) * 5;
}

const MANUAL_VALUE = "__manual__";

export function ShiftStartModal({ open, requirePin, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  const [operators, setOperators]   = useState<Operator[]>([]);
  const [selectedId, setSelectedId] = useState<string>(MANUAL_VALUE);
  const [name, setName]             = useState("");
  const [pin, setPin]               = useState("");
  const [notes, setNotes]           = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selHour, setSelHour]       = useState(() => new Date().getHours());
  const [selMin, setSelMin]         = useState(() => floorTo5(new Date().getMinutes()));
  const [busy, setBusy]             = useState(false);
  const [err, setErr]               = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<Operator[]>("list_operators").then((ops) => {
        setOperators(ops.filter((o) => o.active));
        if (ops.filter((o) => o.active).length === 0) setSelectedId(MANUAL_VALUE);
      }).catch(() => {})
    );
  }, [open]);

  if (!open) return null;

  const nowH = new Date().getHours();
  const nowM = new Date().getMinutes();
  const maxMin = selHour < nowH ? 55 : floorTo5(nowM);

  const isManual = selectedId === MANUAL_VALUE;
  const selectedOp = operators.find((o) => o.id === selectedId);
  const effectiveName = isManual ? name.trim() : (selectedOp?.name ?? "");
  const needsPin = requirePin;

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      let overrideMs: number | undefined;
      if (showAdvanced) {
        const d = new Date();
        d.setHours(selHour, selMin, 0, 0);
        overrideMs = d.getTime();
      }
      await onConfirm({
        operator_name: effectiveName,
        operator_id: isManual ? undefined : selectedId,
        pin: needsPin ? pin : pin || undefined,
        notes: notes.trim() || undefined,
        started_at_override: overrideMs,
      });
      setName(""); setPin(""); setNotes("");
      setSelectedId(operators.length > 0 ? operators[0]!.id : MANUAL_VALUE);
      setSelHour(new Date().getHours());
      setSelMin(floorTo5(new Date().getMinutes()));
      setShowAdvanced(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-border-primary bg-bg-card p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-text-primary">{t("shiftStart.title")}</h2>

        {/* Operator selector */}
        <div>
          <label className="mb-1 block text-sm text-text-secondary">{t("shiftStart.operatorName")}</label>
          {operators.length > 0 ? (
            <>
              <select
                value={selectedId}
                onChange={(e) => { setSelectedId(e.target.value); setPin(""); }}
                className="w-full rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
              >
                {operators.map((op) => (
                  <option key={op.id} value={op.id}>{op.name}</option>
                ))}
                <option value={MANUAL_VALUE}>{t("shiftStart.enterManually")}</option>
              </select>
              {isManual && (
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
                  placeholder={t("shiftStart.operatorNamePlaceholder")}
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && !busy && effectiveName && void submit()}
                />
              )}
            </>
          ) : (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
              placeholder={t("shiftStart.operatorNamePlaceholder")}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && !busy && effectiveName && void submit()}
            />
          )}
        </div>

        {/* PIN */}
        {needsPin ? (
          <div>
            <label className="mb-1 block text-sm text-text-secondary">{t("shiftStart.pin")}</label>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
              placeholder="••••"
            />
          </div>
        ) : null}

        {/* Advanced toggle */}
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary hover:text-text-primary transition-colors"
        >
          <span className={`transition-transform duration-150 ${showAdvanced ? "rotate-90" : ""}`}>▶</span>
          {t("shiftStart.advanced")}
        </button>

        {showAdvanced && (
          <div className="flex flex-col gap-3 rounded-lg border border-border-secondary bg-bg-secondary/50 px-4 py-3">
            <div>
              <label className="mb-2 block text-sm text-text-secondary">{t("shiftStart.startedAt")}</label>
              <div className="flex items-center gap-2">
                <select
                  value={selHour}
                  onChange={(e) => {
                    const h = Number(e.target.value);
                    const curMaxMin = h < nowH ? 55 : floorTo5(nowM);
                    setSelHour(h);
                    if (selMin > curMaxMin) setSelMin(curMaxMin);
                  }}
                  className="flex-1 rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
                >
                  {Array.from({ length: nowH + 1 }, (_, i) => (
                    <option key={i} value={i}>{String(i).padStart(2, "0")}</option>
                  ))}
                </select>
                <span className="font-mono text-lg font-bold text-text-muted">:</span>
                <select
                  value={selMin}
                  onChange={(e) => setSelMin(Number(e.target.value))}
                  className="flex-1 rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
                >
                  {Array.from({ length: Math.floor(maxMin / 5) + 1 }, (_, i) => i * 5).map((m) => (
                    <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
                  ))}
                </select>
              </div>
              <p className="mt-1 text-xs text-text-muted">{t("shiftStart.startedAtHint")}</p>
            </div>
            <div>
              <label className="mb-1 block text-sm text-text-secondary">{t("shiftStart.notes")}</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none resize-none"
                placeholder={t("shiftStart.notesPlaceholder")}
              />
            </div>
          </div>
        )}

        {err && (
          <p className="rounded-lg bg-accent-red/10 px-3 py-2 text-sm text-accent-red-light">{err}</p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-lg border border-border-primary py-2 text-sm text-text-secondary hover:bg-bg-secondary disabled:opacity-40"
          >
            {t("shiftStart.cancel")}
          </button>
          <button
            type="button"
            disabled={!effectiveName || busy}
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
