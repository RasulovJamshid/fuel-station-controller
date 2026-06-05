import { useState } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  open: boolean;
  forceChange?: boolean;
  onSuccess: (token: string, mustChangePin: boolean) => void;
  onCancel: () => void;
}

export function AdminPinModal({ open, forceChange, onSuccess, onCancel }: Props) {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<{ token: string; must_change_pin: boolean }>("admin_login", {
        pin,
      });
      onSuccess(res.token, res.must_change_pin);
      setPin("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-pin-title"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-border-primary bg-bg-card p-6 shadow-xl"
      >
        <h2 id="admin-pin-title" className="text-lg font-semibold text-text-primary">
          {t("adminPin.title")}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          {forceChange ? t("adminPin.forceChange") : t("adminPin.desc")}
        </p>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          className="mt-4 w-full rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-text-primary focus:border-border-focus focus:outline-none"
          placeholder={t("adminPin.placeholder")}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          autoFocus
        />
        {error && <p className="mt-2 text-sm text-accent-red-light">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-bg-secondary"
          >
            {t("adminPin.cancel")}
          </button>
          <button
            type="submit"
            disabled={loading || pin.length < 4}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
          >
            {loading ? t("adminPin.checking") : t("adminPin.unlock")}
          </button>
        </div>
      </form>
    </div>
  );
}
