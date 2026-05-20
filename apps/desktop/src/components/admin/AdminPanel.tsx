import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AdminPriceEntry,
  AdminSettingsSnapshot,
  Operator,
  PriceChange,
  ShiftMode,
  ShiftSlot,
  UpdatePriceCmd,
} from "../../types/api";
import { useAppStore } from "../../store";

function ToggleSwitch({
  checked,
  onChange,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 ${
        checked
          ? "border-sky-600 bg-sky-600"
          : "border-slate-600 bg-slate-700"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
import { AdminProductsSection } from "./AdminProductsSection";

const ADMIN_TOKEN_KEY = "azs_admin_token";

export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function formatPrice(n: number): string {
  if (n <= 0) return "—";
  return new Intl.NumberFormat("uz-UZ").format(n);
}

interface Props {
  token: string;
  mustChangePin?: boolean;
  onLogout: () => void;
  onPinChanged?: () => void;
}

export function AdminPanel({ token, mustChangePin, onLogout, onPinChanged }: Props) {
  const setSiteSnapshot = useAppStore((s) => s.setSiteSnapshot);
  const setInvokeError = useAppStore((s) => s.setInvokeError);
  const smallScreen = useAppStore((s) => s.smallScreen);
  const setSmallScreen = useAppStore((s) => s.setSmallScreen);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  const [prices, setPrices] = useState<AdminPriceEntry[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<PriceChange[]>([]);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [settings, setSettings] = useState<AdminSettingsSnapshot | null>(null);
  const [shiftMode, setShiftMode] = useState<ShiftMode>("manual");
  const [shiftSlots, setShiftSlots] = useState<ShiftSlot[]>([]);
  const [newOpName, setNewOpName] = useState("");
  const [newOpPin, setNewOpPin] = useState("");
  const [pinCurrent, setPinCurrent] = useState("");
  const [pinNew, setPinNew] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const rowKey = (fpId: string, nozzle: number) => `${fpId}:${nozzle}`;

  const loadAll = useCallback(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const [p, h, ops, s] = await Promise.all([
      invoke<AdminPriceEntry[]>("admin_get_prices", { token }),
      invoke<PriceChange[]>("admin_get_price_history", { token, limit: 50 }),
      invoke<Operator[]>("admin_list_operators", { token }),
      invoke<AdminSettingsSnapshot>("admin_get_settings", { token }),
    ]);
    setPrices(p);
    setHistory(h);
    setOperators(ops);
    setSettings(s);
    setShiftMode((s.shift_mode as ShiftMode) || "manual");
    setShiftSlots(s.shift_schedule ?? []);
    const d: Record<string, string> = {};
    for (const row of p) {
      d[rowKey(row.fp_id, row.nozzle_index)] = String(row.price);
    }
    setDraft(d);
  }, [token]);

  useEffect(() => {
    loadAll().catch((e) => setInvokeError(e instanceof Error ? e.message : String(e)));
  }, [loadAll, setInvokeError]);

  const refreshConfig = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const snap = await invoke<import("../../types/api").SiteSnapshot>("get_site_config");
    setSiteSnapshot(snap);
  };

  const savePrices = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const updates: UpdatePriceCmd[] = [];
      for (const row of prices) {
        const key = rowKey(row.fp_id, row.nozzle_index);
        const raw = draft[key];
        if (raw === undefined) continue;
        const price = parseInt(raw, 10);
        if (Number.isNaN(price) || price <= 0) continue;
        if (price !== row.price) {
          updates.push({ fp_id: row.fp_id, nozzle_index: row.nozzle_index, price });
        }
      }
      if (updates.length === 0) {
        setMsg("No price changes to save.");
        return;
      }
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("admin_update_prices", { token, updates });
      await loadAll();
      await refreshConfig();
      setMsg(`Saved ${updates.length} price(s).`);
    } catch (e) {
      setInvokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyNow = async (fpId: string) => {
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("admin_apply_prices_now", { token, fpId });
      setMsg(`Pushed prices to ${fpId} (pre-authorize while idle).`);
    } catch (e) {
      setInvokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fpIds = useMemo(() => [...new Set(prices.map((p) => p.fp_id))], [prices]);

  const saveSettings = async () => {
    if (!settings) return;
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("admin_save_settings", {
        token,
        body: {
          polling_interval_ms: settings.polling_interval_ms,
          polling_offline_threshold_polls: settings.polling_offline_threshold_polls,
          preauth_timeout_seconds: settings.preauth_timeout_seconds,
          shifts_warn_before_end_minutes: settings.shifts_warn_before_end_minutes,
        },
      });
      setMsg("Settings saved to site.config.json.");
    } catch (e) {
      setInvokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveShiftSchedule = async () => {
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("admin_shift_schedule", { token, mode: shiftMode, scheduled: shiftSlots });
      await refreshConfig();
      setMsg("Shift schedule saved.");
    } catch (e) {
      setInvokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addOperator = async () => {
    if (!newOpName.trim()) return;
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("admin_create_operator", {
        token,
        name: newOpName.trim(),
        pin: newOpPin.trim() || null,
      });
      setNewOpName("");
      setNewOpPin("");
      await loadAll();
    } catch (e) {
      setInvokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changePin = async () => {
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("admin_change_pin", {
        token,
        currentPin: pinCurrent,
        newPin: pinNew,
      });
      setPinCurrent("");
      setPinNew("");
      onPinChanged?.();
      setMsg("Admin PIN updated.");
    } catch (e) {
      setInvokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4 text-slate-200">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Station admin</h1>
        <button
          type="button"
          onClick={() => {
            setAdminToken(null);
            onLogout();
          }}
          className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Lock admin
        </button>
      </div>

      {mustChangePin && (
        <p className="mb-4 rounded-lg border border-amber-700/50 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          Change the default admin PIN (0000) below before leaving this panel.
        </p>
      )}
      {msg && (
        <p className="mb-4 rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
          {msg}
        </p>
      )}

      <AdminProductsSection
        token={token}
        onMessage={setMsg}
        onError={(m) => setInvokeError(m)}
      />

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-medium text-amber-400">Prices</h2>
        <div className="overflow-x-auto rounded-lg border border-slate-700">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-slate-800/80 text-slate-400">
              <tr>
                <th className="px-3 py-2">FP</th>
                <th className="px-3 py-2">Label</th>
                <th className="px-3 py-2">Nozzle</th>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2">Current</th>
                <th className="px-3 py-2">New price</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {prices.map((row) => {
                const key = rowKey(row.fp_id, row.nozzle_index);
                const showApply =
                  fpIds.indexOf(row.fp_id) ===
                  prices.findIndex((p) => p.fp_id === row.fp_id);
                return (
                  <tr key={key} className="border-t border-slate-700/80">
                    <td className="px-3 py-2 font-mono">{row.fp_id}</td>
                    <td className="px-3 py-2">{row.label}</td>
                    <td className="px-3 py-2">{row.nozzle_index}</td>
                    <td className="px-3 py-2">{row.product_name}</td>
                    <td className="px-3 py-2 font-mono">{formatPrice(row.price)}</td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        className="w-28 rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono"
                        value={draft[key] ?? ""}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, [key]: e.target.value }))
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      {showApply && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => applyNow(row.fp_id)}
                          className="text-xs text-sky-400 hover:underline disabled:opacity-50"
                        >
                          Apply now
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={savePrices}
          className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
        >
          Save prices
        </button>

        <h3 className="mb-2 mt-6 text-sm font-medium text-slate-400">Price history</h3>
        <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-slate-400">
          {history.map((h) => (
            <li key={h.id}>
              {new Date(h.changed_at).toLocaleString()} — {h.fp_id} #{h.nozzle_index}{" "}
              {h.product_name}: {formatPrice(h.old_price)} → {formatPrice(h.new_price)} (
              {h.changed_by})
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-medium text-amber-400">Operators</h2>
        <ul className="mb-3 space-y-2">
          {operators.map((op) => (
            <li
              key={op.id}
              className="flex flex-wrap items-center gap-2 rounded border border-slate-700 px-3 py-2 text-sm"
            >
              <span className="font-medium">{op.name}</span>
              <span className="text-slate-500">{op.has_pin ? "PIN set" : "No PIN"}</span>
              <span className={op.active ? "text-emerald-400" : "text-slate-500"}>
                {op.active ? "Active" : "Inactive"}
              </span>
              <button
                type="button"
                disabled={busy}
                className="text-xs text-sky-400 hover:underline"
                onClick={async () => {
                  const { invoke } = await import("@tauri-apps/api/core");
                  await invoke("admin_update_operator", {
                    token,
                    id: op.id,
                    active: !op.active,
                    pin: null,
                  });
                  await loadAll();
                }}
              >
                {op.active ? "Deactivate" : "Reactivate"}
              </button>
              <button
                type="button"
                disabled={busy}
                className="text-xs text-sky-400 hover:underline"
                onClick={async () => {
                  const p = window.prompt("New PIN for operator (leave empty to skip):");
                  if (p === null) return;
                  const { invoke } = await import("@tauri-apps/api/core");
                  await invoke("admin_update_operator", {
                    token,
                    id: op.id,
                    active: null,
                    pin: p.trim() || null,
                  });
                  await loadAll();
                }}
              >
                Reset PIN
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <input
            placeholder="Name"
            value={newOpName}
            onChange={(e) => setNewOpName(e.target.value)}
            className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
          />
          <input
            placeholder="PIN (optional)"
            type="password"
            value={newOpPin}
            onChange={(e) => setNewOpPin(e.target.value)}
            className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={busy}
            onClick={addOperator}
            className="rounded-lg bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600"
          >
            Add operator
          </button>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-medium text-amber-400">Shift schedule</h2>
        <select
          value={shiftMode}
          onChange={(e) => setShiftMode(e.target.value as ShiftMode)}
          className="mb-2 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
        >
          <option value="disabled">Disabled</option>
          <option value="manual">Manual</option>
          <option value="scheduled">Scheduled</option>
        </select>
        {shiftMode === "scheduled" && (
          <div className="mb-2 space-y-2">
            {shiftSlots.map((slot, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <input
                  placeholder="Name"
                  value={slot.name}
                  onChange={(e) => {
                    const next = [...shiftSlots];
                    next[i] = { ...slot, name: e.target.value };
                    setShiftSlots(next);
                  }}
                  className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
                />
                <input
                  placeholder="Start HH:MM"
                  value={slot.start}
                  onChange={(e) => {
                    const next = [...shiftSlots];
                    next[i] = { ...slot, start: e.target.value };
                    setShiftSlots(next);
                  }}
                  className="w-24 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
                />
                <input
                  placeholder="End HH:MM"
                  value={slot.end}
                  onChange={(e) => {
                    const next = [...shiftSlots];
                    next[i] = { ...slot, end: e.target.value };
                    setShiftSlots(next);
                  }}
                  className="w-24 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
                />
              </div>
            ))}
            <button
              type="button"
              className="text-xs text-sky-400"
              onClick={() =>
                setShiftSlots([...shiftSlots, { name: "Shift", start: "06:00", end: "14:00" }])
              }
            >
              + Add slot
            </button>
          </div>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={saveShiftSchedule}
          className="rounded-lg bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
        >
          Save shift schedule
        </button>
      </section>

      {settings && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-medium text-amber-400">Settings</h2>
          <div className="grid max-w-md gap-3 text-sm">
            <label className="flex flex-col gap-1">
              Polling interval (ms)
              <input
                type="number"
                value={settings.polling_interval_ms}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    polling_interval_ms: Number(e.target.value),
                  })
                }
                className="rounded border border-slate-600 bg-slate-800 px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              Offline threshold (polls)
              <input
                type="number"
                value={settings.polling_offline_threshold_polls}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    polling_offline_threshold_polls: Number(e.target.value),
                  })
                }
                className="rounded border border-slate-600 bg-slate-800 px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              Pre-auth timeout (seconds)
              <input
                type="number"
                value={settings.preauth_timeout_seconds}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    preauth_timeout_seconds: Number(e.target.value),
                  })
                }
                className="rounded border border-slate-600 bg-slate-800 px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              Shift warn before end (minutes)
              <input
                type="number"
                value={settings.shifts_warn_before_end_minutes}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    shifts_warn_before_end_minutes: Number(e.target.value),
                  })
                }
                className="rounded border border-slate-600 bg-slate-800 px-2 py-1"
              />
            </label>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={saveSettings}
            className="mt-3 rounded-lg bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
          >
            Save settings
          </button>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-1 text-lg font-medium text-amber-400">Display</h2>
        <p className="mb-4 text-sm text-slate-500">
          Adjust the interface appearance and layout for this station.
        </p>
        <div className="flex flex-col gap-3">
          {/* Theme */}
          <div className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-slate-100">Light mode</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Switch to a light colour scheme (warm off-white background)
              </p>
            </div>
            <ToggleSwitch
              id="theme-toggle"
              checked={theme === "light"}
              onChange={(v) => setTheme(v ? "light" : "dark")}
            />
          </div>
          {/* Small screen */}
          <div className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-slate-100">Small-screen mode</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Compact layout optimised for smaller displays
              </p>
            </div>
            <ToggleSwitch
              id="small-screen-toggle"
              checked={smallScreen}
              onChange={setSmallScreen}
            />
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium text-amber-400">Change admin PIN</h2>
        <div className="flex max-w-sm flex-col gap-2">
          <input
            type="password"
            placeholder="Current PIN"
            value={pinCurrent}
            onChange={(e) => setPinCurrent(e.target.value)}
            className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
          />
          <input
            type="password"
            placeholder="New PIN"
            value={pinNew}
            onChange={(e) => setPinNew(e.target.value)}
            className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={busy}
            onClick={changePin}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm text-white hover:bg-amber-500"
          >
            Update PIN
          </button>
        </div>
      </section>
    </div>
  );
}
