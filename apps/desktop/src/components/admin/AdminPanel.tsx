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
import { statusTag } from "../../types/api";
import { useAppStore } from "../../store";
import { AdminProductsSection } from "./AdminProductsSection";

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

// Shared input/select class — adapts to both light and dark themes via CSS vars.
const inputCls =
  "rounded-lg border border-border-primary/80 bg-bg-secondary/60 px-3 py-2 text-sm font-medium text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-blue/50 focus:border-accent-blue/50 transition-all shadow-inner placeholder:text-text-muted";

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
  const states = useAppStore((s) => s.states);

  // Nozzles that are physically lifted right now (across all dispensers).
  const liftedNozzles = useMemo(() => {
    return states
      .filter((s) => {
        const tag = statusTag(s.status);
        return (
          (tag === "NOZZLE_UP" ||
            tag === "AUTHORIZING" ||
            tag === "DELIVERING" ||
            tag === "STOPPED") &&
          s.nozzle_index != null
        );
      })
      .map((s) => ({
        fpId: s.fp_id,
        nozzleIndex: s.nozzle_index!,
        productName: s.product_name,
        productColor: s.product_color,
      }));
  }, [states]);

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

  const loadAll = useCallback(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const results = await Promise.allSettled([
      invoke<AdminPriceEntry[]>("admin_get_prices", { token }),
      invoke<PriceChange[]>("admin_get_price_history", { token, limit: 50 }),
      invoke<Operator[]>("admin_list_operators", { token }),
      invoke<AdminSettingsSnapshot>("admin_get_settings", { token }),
    ]);
    const err = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    if (err) {
      const msg =
        err.reason instanceof Error ? err.reason.message : String(err.reason);
      setInvokeError(msg);
    }
    const p =
      results[0].status === "fulfilled" ? results[0].value : [];
    const h =
      results[1].status === "fulfilled" ? results[1].value : [];
    const ops =
      results[2].status === "fulfilled" ? results[2].value : [];
    const s =
      results[3].status === "fulfilled" ? results[3].value : null;
    setPrices(p);
    setHistory(h);
    setOperators(ops);
    if (s) {
      setSettings(s);
      setShiftMode((s.shift_mode as ShiftMode) || "manual");
      setShiftSlots(s.shift_schedule ?? []);
    }
    // One draft entry per product (first price seen wins).
    const d: Record<string, string> = {};
    for (const row of p) {
      const key = String(row.product_id);
      if (!(key in d)) d[key] = String(row.price);
    }
    setDraft(d);
  }, [token, setInvokeError]);

  useEffect(() => {
    loadAll().catch((e) => setInvokeError(e instanceof Error ? e.message : String(e)));
  }, [loadAll, setInvokeError]);

  const refreshConfig = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const snap = await invoke<import("../../types/api").SiteSnapshot>("get_site_config");
    setSiteSnapshot(snap);
  };

  // One row per product for display, sorted by product_id.
  const productPrices = useMemo(() => {
    const seen = new Map<number, AdminPriceEntry>();
    for (const row of prices) {
      if (!seen.has(row.product_id)) seen.set(row.product_id, row);
    }
    return [...seen.values()].sort((a, b) => a.product_id - b.product_id);
  }, [prices]);

  // product_id → price for nozzle saves (includes unsaved draft from Prices section).
  const productPriceMap = useMemo(() => {
    const map: Record<number, number> = {};
    for (const row of prices) {
      if (!(row.product_id in map)) map[row.product_id] = row.price;
    }
    for (const prod of productPrices) {
      const raw = draft[String(prod.product_id)];
      if (raw === undefined || raw.trim() === "") continue;
      const p = parseInt(raw.trim(), 10);
      if (!Number.isNaN(p) && p > 0) map[prod.product_id] = p;
    }
    return map;
  }, [prices, productPrices, draft]);

  const savePrices = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (productPrices.length === 0) {
        setMsg("No products with active nozzles — add products and nozzles first.");
        return;
      }
      const updates: UpdatePriceCmd[] = [];
      for (const prod of productPrices) {
        const key = String(prod.product_id);
        const raw = draft[key];
        if (raw === undefined || raw.trim() === "") continue;
        const newPrice = parseInt(raw.trim(), 10);
        if (Number.isNaN(newPrice) || newPrice <= 0) {
          setMsg(`Enter a valid price for ${prod.product_name}.`);
          return;
        }
        if (newPrice === prod.price) continue;
        for (const row of prices) {
          if (row.product_id === prod.product_id) {
            updates.push({
              fp_id: row.fp_id,
              nozzle_index: row.nozzle_index,
              price: newPrice,
            });
          }
        }
      }
      if (updates.length === 0) {
        setMsg("No price changes to save.");
        return;
      }
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("admin_update_prices", { token, updates });

      setPrices((prev) => {
        const next = prev.map((row) => {
          const u = updates.find(
            (u) => u.fp_id === row.fp_id && u.nozzle_index === row.nozzle_index,
          );
          return u ? { ...row, price: u.price } : row;
        });
        const nextDraft: Record<string, string> = {};
        for (const row of next) {
          const k = String(row.product_id);
          if (!(k in nextDraft)) nextDraft[k] = String(row.price);
        }
        setDraft(nextDraft);
        return next;
      });
      setMsg(`Prices saved (${updates.length} nozzle update${updates.length === 1 ? "" : "s"}).`);
      // Refresh history and config in the background (errors don't undo the save).
      invoke<PriceChange[]>("admin_get_price_history", { token, limit: 50 })
        .then(setHistory)
        .catch(() => {});
      refreshConfig().catch(() => {});
    } catch (e) {
      setMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

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

  // Stable callback — avoids re-triggering AdminProductsSection's useEffect
  // every render (inline arrows change identity every render).
  const handleProductsError = useCallback(
    (m: string) => setInvokeError(m),
    [setInvokeError],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-5 text-text-primary gap-6 bg-bg-primary">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">Station Admin</h1>
        <button
          type="button"
          onClick={() => {
            setAdminToken(null);
            onLogout();
          }}
          className="rounded-xl border border-border-primary/80 bg-bg-secondary/80 px-4 py-2 text-sm font-bold text-text-primary shadow-sm transition-all hover:bg-bg-tertiary hover:shadow-button"
        >
          Lock admin
        </button>
      </div>

      {mustChangePin && (
        <div className="rounded-xl border border-accent-amber/40 bg-accent-amber/10 px-4 py-3 text-sm font-semibold text-accent-amber-dark dark:text-accent-amber-light shadow-sm">
          Change the default admin PIN (0000) below before leaving this panel.
        </div>
      )}
      {msg && (
        <div className="rounded-xl border border-accent-emerald/40 bg-accent-emerald/10 px-4 py-3 text-sm font-semibold text-accent-emerald-dark dark:text-accent-emerald-light shadow-sm">
          {msg}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-8 flex flex-col gap-6">
          <AdminProductsSection
            token={token}
            onMessage={setMsg}
            onError={handleProductsError}
            onCatalogChanged={loadAll}
            liftedNozzles={liftedNozzles}
            productPriceMap={productPriceMap}
          />

        <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
          <h2 className="text-lg font-bold text-text-primary">Prices</h2>
          <p className="mt-1 mb-4 text-sm font-medium text-text-secondary">
            Batch-update: sets the same price for every nozzle dispensing a product across all dispensers.
            To set a different price per nozzle, edit the Price column in the Products &amp; nozzles section above.
          </p>
          <div className="overflow-x-auto rounded-xl border border-border-primary/60 shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg-secondary/95 text-[10px] font-bold uppercase tracking-wider text-text-muted backdrop-blur-sm">
                <tr>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Current price</th>
                  <th className="px-4 py-3">New price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-secondary/60 bg-bg-card/40">
                {productPrices.map((row) => {
                  const key = String(row.product_id);
                  return (
                    <tr key={key} className="transition-colors hover:bg-bg-tertiary/40">
                      <td className="px-4 py-3 font-semibold text-text-primary">{row.product_name}</td>
                      <td className="px-4 py-3 font-mono font-medium text-text-secondary">{formatPrice(row.price)}</td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          className={`w-40 font-mono ${inputCls}`}
                          value={draft[key] ?? ""}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, [key]: e.target.value }))
                          }
                        />
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
            className="mt-4 rounded-xl border border-accent-amber/40 bg-accent-amber/15 px-5 py-2.5 text-sm font-bold tracking-wide text-accent-amber shadow-button transition-all hover:bg-accent-amber/25 hover:shadow-button-hover disabled:opacity-50"
          >
            Save prices
          </button>

          <h3 className="mb-2 mt-6 text-[10px] font-bold uppercase tracking-wider text-text-muted">Price history</h3>
          <ul className="max-h-40 space-y-1.5 overflow-y-auto pr-2">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between rounded-lg border border-border-primary/40 bg-bg-secondary/30 px-3 py-2 text-xs transition-colors hover:bg-bg-secondary/60">
                <span className="font-mono font-medium text-text-tertiary">{new Date(h.changed_at).toLocaleString()}</span>
                <span className="font-semibold text-text-primary">{h.fp_id} #{h.nozzle_index} <span className="text-text-muted">·</span> {h.product_name}</span>
                <span className="font-mono font-bold text-accent-blue">{formatPrice(h.old_price)} <span className="text-text-muted font-normal">→</span> {formatPrice(h.new_price)}</span>
                <span className="text-text-secondary font-medium">({h.changed_by})</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="xl:col-span-4 flex flex-col gap-6">

        <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
          <h2 className="mb-4 text-lg font-bold text-text-primary">Operators</h2>
          <ul className="mb-4 grid gap-3 grid-cols-1">
            {operators.map((op) => (
              <li
                key={op.id}
                className="flex flex-col gap-3 rounded-xl border border-border-primary/60 bg-bg-secondary/40 p-4 shadow-sm transition-colors hover:bg-bg-tertiary/40"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-text-primary">{op.name}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${op.active ? "border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald" : "border-border-secondary bg-bg-secondary text-text-secondary"}`}>
                    {op.active ? "Active" : "Inactive"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className="text-text-muted">{op.has_pin ? "🔐 PIN set" : "No PIN"}</span>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      disabled={busy}
                      className="font-bold text-accent-blue transition-colors hover:text-accent-blue-light disabled:opacity-50"
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
                      className="font-bold text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
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
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-3 rounded-xl border border-border-primary/40 bg-bg-secondary/20 p-4">
            <input
              placeholder="Name"
              value={newOpName}
              onChange={(e) => setNewOpName(e.target.value)}
              className={`w-full ${inputCls}`}
            />
            <input
              placeholder="PIN (optional)"
              type="password"
              value={newOpPin}
              onChange={(e) => setNewOpPin(e.target.value)}
              className={`w-full ${inputCls}`}
            />
            <button
              type="button"
              disabled={busy}
              onClick={addOperator}
              className="mt-1 w-full rounded-xl bg-bg-primary px-5 py-2.5 text-sm font-bold text-text-primary border border-border-primary shadow-sm hover:bg-bg-tertiary transition-all disabled:opacity-50"
            >
              Add operator
            </button>
          </div>
        </section>


        <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
          <h2 className="mb-4 text-lg font-bold text-text-primary">Shift schedule</h2>
          <select
            value={shiftMode}
            onChange={(e) => setShiftMode(e.target.value as ShiftMode)}
            className={`mb-4 w-full ${inputCls}`}
          >
            <option value="disabled">Disabled</option>
            <option value="manual">Manual</option>
            <option value="scheduled">Scheduled</option>
          </select>
          {shiftMode === "scheduled" && (
            <div className="mb-4 space-y-3">
              {shiftSlots.map((slot, i) => (
                <div key={i} className="flex flex-wrap gap-2 rounded-xl border border-border-primary/40 bg-bg-secondary/20 p-3">
                  <input
                    placeholder="Name"
                    value={slot.name}
                    onChange={(e) => {
                      const next = [...shiftSlots];
                      next[i] = { ...slot, name: e.target.value };
                      setShiftSlots(next);
                    }}
                    className={`flex-1 ${inputCls}`}
                  />
                  <input
                    placeholder="Start HH:MM"
                    value={slot.start}
                    onChange={(e) => {
                      const next = [...shiftSlots];
                      next[i] = { ...slot, start: e.target.value };
                      setShiftSlots(next);
                    }}
                    className={`w-24 ${inputCls}`}
                  />
                  <input
                    placeholder="End HH:MM"
                    value={slot.end}
                    onChange={(e) => {
                      const next = [...shiftSlots];
                      next[i] = { ...slot, end: e.target.value };
                      setShiftSlots(next);
                    }}
                    className={`w-24 ${inputCls}`}
                  />
                </div>
              ))}
              <button
                type="button"
                className="text-xs font-bold text-accent-blue transition-colors hover:text-accent-blue-light"
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
            className="rounded-xl border border-border-primary bg-bg-primary px-5 py-2.5 text-sm font-bold text-text-primary shadow-sm hover:bg-bg-tertiary transition-all"
          >
            Save schedule
          </button>
        </section>

        {settings && (
          <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
            <h2 className="mb-4 text-lg font-bold text-text-primary">Settings</h2>
            <div className="grid gap-4 text-sm font-medium">
              <label className="flex flex-col gap-1.5 text-text-secondary">
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
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-text-secondary">
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
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-text-secondary">
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
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-text-secondary">
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
                  className={inputCls}
                />
              </label>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={saveSettings}
              className="mt-5 rounded-xl border border-border-primary bg-bg-primary px-5 py-2.5 text-sm font-bold text-text-primary shadow-sm hover:bg-bg-tertiary transition-all"
            >
              Save settings
            </button>
          </section>
        )}

        <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
          <h2 className="mb-1 text-lg font-bold text-text-primary">Display</h2>
          <p className="mb-5 text-sm font-medium text-text-muted">
            Adjust the interface appearance and layout for this station.
          </p>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between rounded-xl border border-border-primary/60 bg-bg-secondary/60 px-5 py-4 transition-colors hover:bg-bg-tertiary/40">
              <div>
                <p className="text-sm font-bold text-text-primary">Light mode</p>
                <p className="mt-0.5 text-xs font-medium text-text-muted">
                  Switch to a light colour scheme (warm off-white background)
                </p>
              </div>
              <ToggleSwitch
                id="theme-toggle"
                checked={theme === "light"}
                onChange={(v) => setTheme(v ? "light" : "dark")}
              />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border-primary/60 bg-bg-secondary/60 px-5 py-4 transition-colors hover:bg-bg-tertiary/40">
              <div>
                <p className="text-sm font-bold text-text-primary">Small-screen mode</p>
                <p className="mt-0.5 text-xs font-medium text-text-muted">
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

        <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
          <h2 className="mb-4 text-lg font-bold text-text-primary">Change admin PIN</h2>
          <div className="flex flex-col gap-3">
            <input
              type="password"
              placeholder="Current PIN"
              value={pinCurrent}
              onChange={(e) => setPinCurrent(e.target.value)}
              className={inputCls}
            />
            <input
              type="password"
              placeholder="New PIN"
              value={pinNew}
              onChange={(e) => setPinNew(e.target.value)}
              className={inputCls}
            />
            <button
              type="button"
              disabled={busy}
              onClick={changePin}
              className="mt-2 rounded-xl bg-accent-amber px-5 py-2.5 text-sm font-bold text-text-inverse shadow-button transition-all hover:brightness-110 hover:shadow-button-hover"
            >
              Update PIN
            </button>
          </div>
        </section>
      </div>
    </div>
    </div>
  );
}
