import { useState } from "react";

interface Props {
  open: boolean;
  forceChange?: boolean;
  onSuccess: (token: string, mustChangePin: boolean) => void;
  onCancel: () => void;
}

export function AdminPinModal({ open, forceChange, onSuccess, onCancel }: Props) {
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
        className="w-full max-w-sm rounded-xl border border-slate-600 bg-slate-900 p-6 shadow-xl"
      >
        <h2 id="admin-pin-title" className="text-lg font-semibold text-white">
          Admin access
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          {forceChange
            ? "Default PIN detected — enter 0000, then change your PIN in Admin settings."
            : "Enter the station admin PIN. Operators cannot access this area."}
        </p>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          className="mt-4 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-white"
          placeholder="Admin PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          autoFocus
        />
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || pin.length < 4}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
          >
            {loading ? "Checking…" : "Unlock"}
          </button>
        </div>
      </form>
    </div>
  );
}
