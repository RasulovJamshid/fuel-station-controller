import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HandoverCmd, Operator, Shift } from "../../types/api";

type Props = {
  open: boolean;
  outgoingShift: Shift | null;
  requirePin: boolean;
  onClose: () => void;
  onConfirm: (cmd: HandoverCmd) => Promise<void>;
};

function floorTo5(m: number): number {
  return Math.floor(m / 5) * 5;
}

const MANUAL_VALUE = "__manual__";

export function ShiftHandoverModal({
  open,
  outgoingShift,
  requirePin,
  onClose,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  const [operators, setOperators]     = useState<Operator[]>([]);
  const [selectedId, setSelectedId]   = useState<string>(MANUAL_VALUE);
  const [incomingName, setIncomingName] = useState("");
  const [incomingPin, setIncomingPin] = useState("");
  const [notes, setNotes]             = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selHour, setSelHour]         = useState(() => new Date().getHours());
  const [selMin, setSelMin]           = useState(() => floorTo5(new Date().getMinutes()));
  const [busy, setBusy]               = useState(false);
  const [err, setErr]                 = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<Operator[]>("list_operators").then((ops) => {
        const active = ops.filter((o) => o.active);
        setOperators(active);
        if (active.length === 0) setSelectedId(MANUAL_VALUE);
      }).catch(() => {})
    );
  }, [open]);

  if (!open || !outgoingShift) return null;

  const nowH = new Date().getHours();
  const nowM = new Date().getMinutes();
  const maxMin = selHour < nowH ? 55 : floorTo5(nowM);

  const isManual = selectedId === MANUAL_VALUE;
  const selectedOp = operators.find((o) => o.id === selectedId);
  const effectiveName = isManual ? incomingName.trim() : (selectedOp?.name ?? "");

  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

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
        outgoing_shift_id: outgoingShift.id,
        incoming_operator: effectiveName,
        incoming_operator_id: isManual ? undefined : selectedId,
        incoming_pin: requirePin ? incomingPin : incomingPin || undefined,
        notes: notes.trim() || undefined,
        incoming_started_at_override: overrideMs,
      });
      setIncomingName(""); setIncomingPin(""); setNotes("");
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
      <div className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-border-primary bg-bg-card p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-text-primary">{t("shiftHandover.title")}</h2>

        {/* Outgoing shift summary */}
        <div className="rounded-lg border border-border-secondary bg-bg-secondary/50 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-text-muted">
            {t("shiftHandover.outgoingSummary")}
          </div>
          <div className="mt-1 text-sm font-medium text-text-primary">
            {outgoingShift.operator_name}
            {outgoingShift.shift_name ? (
              <span className="ml-2 text-text-secondary">{outgoingShift.shift_name}</span>
            ) : null}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-xs text-text-muted">{t("shiftHandover.transactions")}</div>
              <div className="font-mono text-sm font-semibold text-text-primary">
                {outgoingShift.total_transactions}
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted">{t("shiftHandover.volume")}</div>
              <div className="font-mono text-sm font-semibold text-accent-blue">
                {fmt.format(outgoingShift.total_volume)} L
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted">{t("shiftHandover.amount")}</div>
              <div className="font-mono text-sm font-semibold text-accent-amber">
                {outgoingShift.total_amount.toLocaleString()}
              </div>
            </div>
          </div>
        </div>

        {/* Incoming operator */}
        <div>
          <label className="mb-1 block text-xs text-text-secondary">{t("shiftHandover.incomingOperator")}</label>
          {operators.length > 0 ? (
            <>
              <select
                value={selectedId}
                onChange={(e) => { setSelectedId(e.target.value); setIncomingPin(""); }}
                className="w-full rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
                autoFocus
              >
                {operators.map((op) => (
                  <option key={op.id} value={op.id}>{op.name}</option>
                ))}
                <option value={MANUAL_VALUE}>{t("shiftStart.enterManually")}</option>
              </select>
              {isManual && (
                <input
                  value={incomingName}
                  onChange={(e) => setIncomingName(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
                  placeholder={t("shiftHandover.incomingOperatorPlaceholder")}
                />
              )}
            </>
          ) : (
            <input
              value={incomingName}
              onChange={(e) => setIncomingName(e.target.value)}
              className="w-full rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
              placeholder={t("shiftHandover.incomingOperatorPlaceholder")}
              autoFocus
            />
          )}
        </div>

        {requirePin ? (
          <div>
            <label className="mb-1 block text-xs text-text-secondary">{t("shiftHandover.incomingPin")}</label>
            <input
              type="password"
              value={incomingPin}
              onChange={(e) => setIncomingPin(e.target.value)}
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
          {t("shiftHandover.advanced")}
        </button>

        {showAdvanced && (
          <div className="flex flex-col gap-3 rounded-lg border border-border-secondary bg-bg-secondary/50 px-4 py-3">
            <div>
              <label className="mb-2 block text-sm text-text-secondary">{t("shiftHandover.incomingStartedAt")}</label>
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
              <p className="mt-1 text-xs text-text-muted">{t("shiftHandover.incomingStartedAtHint")}</p>
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-secondary">{t("shiftHandover.notes")}</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full resize-none rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
                placeholder={t("shiftHandover.notesPlaceholder")}
              />
            </div>
          </div>
        )}

        {!showAdvanced && (
          <div>
            <label className="mb-1 block text-xs text-text-secondary">{t("shiftHandover.notes")}</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
              placeholder={t("shiftHandover.notesPlaceholder")}
            />
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
            className="flex-1 rounded-lg border border-border-primary py-2 text-sm text-text-secondary hover:bg-bg-secondary"
          >
            {t("shiftHandover.cancel")}
          </button>
          <button
            type="button"
            disabled={!effectiveName || busy}
            onClick={() => void submit()}
            className="flex-1 rounded-lg bg-sky-700 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-40"
          >
            {busy ? "…" : t("shiftHandover.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
