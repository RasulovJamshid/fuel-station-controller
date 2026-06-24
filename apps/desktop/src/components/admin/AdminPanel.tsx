import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AdminPriceEntry,
  AdminSettingsSnapshot,
  AtgConfigSnapshot,
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

interface SyncStatus {
  enabled: boolean;
  backend_url: string;
  last_sync_at: number | null;
  last_error: string | null;
  pending_count: number;
  total_synced: number;
  connected: boolean;
  last_price_pull_at: number | null;
  prices_updated: number;
  price_pull_interval_hours?: number;
  price_pull_enabled?: boolean;
}

interface DiscoveredTankSlot {
  slot: number;
  product_height: number;
  water_height: number;
  temperature_c: number;
  product_and_water_volume: number;
  product_volume: number;
  water_volume: number;
}

interface DiscoveredAtgDevice {
  host: string;
  tanks: DiscoveredTankSlot[];
  error?: string;
}

interface AtgDiscoveryResult {
  subnet: string;
  port: number;
  found: string[];
  devices?: DiscoveredAtgDevice[];
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

function is401(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /401|unauthorized/i.test(msg);
}

interface Props {
  token: string;
  mustChangePin?: boolean;
  onLogout: () => void;
  onPinChanged?: () => void;
  onSessionExpired: () => void;
}

export function AdminPanel({ token, mustChangePin, onLogout, onPinChanged, onSessionExpired }: Props) {
  const { t } = useTranslation();
  const setSiteSnapshot = useAppStore((s) => s.setSiteSnapshot);
  const setInvokeError = useAppStore((s) => s.setInvokeError);
  const smallScreen = useAppStore((s) => s.smallScreen);
  const setSmallScreen = useAppStore((s) => s.setSmallScreen);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const dispenserLayout = useAppStore((s) => s.dispenserLayout);
  const setDispenserLayout = useAppStore((s) => s.setDispenserLayout);
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

  // ATG config state
  const [atgConfig, setAtgConfig] = useState<AtgConfigSnapshot | null>(null);
  const [atgPollInterval, setAtgPollInterval] = useState(300);
  const [atgTimeout, setAtgTimeout] = useState(10.0);
  const [atgApiUrl, setAtgApiUrl] = useState("");
  const [atgDiscovering, setAtgDiscovering] = useState(false);
  const [atgDiscovered, setAtgDiscovered] = useState<AtgDiscoveryResult | null>(null);

  const loadAtgConfig = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const cfg = await invoke<AtgConfigSnapshot>("admin_get_atg_config");
      setAtgConfig(cfg);
      setAtgPollInterval(cfg.poll_interval_secs);
      setAtgTimeout(cfg.modbus_timeout_secs);
      setAtgApiUrl(cfg.api_url);
    } catch {
      // ATG may not be available on this service version
    }
  }, []);

  // Sync config state
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncUrl, setSyncUrl] = useState("");
  const [syncApiKey, setSyncApiKey] = useState("");
  const [syncRetryInterval, setSyncRetryInterval] = useState(30);
  const [syncBatchSize, setSyncBatchSize] = useState(100);
  const [syncMaxRetries, setSyncMaxRetries] = useState(10);
  const [syncPricePullInterval, setSyncPricePullInterval] = useState(12);
  const [syncPricePullEnabled, setSyncPricePullEnabled] = useState(true);
  const [showApiKey, setShowApiKey] = useState(false);

  const loadSyncStatus = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const s = await invoke<SyncStatus>("get_sync_status");
      setSyncStatus(s);
      setSyncUrl(s.backend_url);
      if (s.price_pull_interval_hours !== undefined) {
        setSyncPricePullInterval(s.price_pull_interval_hours);
      }
      if (s.price_pull_enabled !== undefined) {
        setSyncPricePullEnabled(s.price_pull_enabled);
      }
    } catch {
      // not fatal — sync may not be configured yet
    }
  }, []);

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
      if (is401(err.reason)) { onSessionExpired(); return; }
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
    loadSyncStatus();
    loadAtgConfig();
  }, [loadAll, setInvokeError, loadSyncStatus, loadAtgConfig]);

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
        setMsg(t("admin.prices.noProducts"));
        return;
      }
      const updates: UpdatePriceCmd[] = [];
      for (const prod of productPrices) {
        const key = String(prod.product_id);
        const raw = draft[key];
        if (raw === undefined || raw.trim() === "") continue;
        const newPrice = parseInt(raw.trim(), 10);
        if (Number.isNaN(newPrice) || newPrice <= 0) {
          setMsg(t("admin.prices.invalidPrice", { name: prod.product_name }));
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
        setMsg(t("admin.prices.noChanges"));
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
      setMsg(t("admin.prices.savedMsg", { count: updates.length }));
      // Refresh history and config in the background (errors don't undo the save).
      invoke<PriceChange[]>("admin_get_price_history", { token, limit: 50 })
        .then(setHistory)
        .catch(() => {});
      refreshConfig().catch(() => {});
    } catch (e) {
      if (is401(e)) { onSessionExpired(); return; }
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
      setMsg(t("admin.settings.savedMsg"));
    } catch (e) {
      if (is401(e)) { onSessionExpired(); return; }
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
      setMsg(t("admin.shiftSchedule.savedMsg"));
    } catch (e) {
      if (is401(e)) { onSessionExpired(); return; }
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
      if (is401(e)) { onSessionExpired(); return; }
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
      setMsg(t("admin.changePin.updatedMsg"));
    } catch (e) {
      if (is401(e)) { onSessionExpired(); return; }
      setInvokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const discoverAtg = async () => {
    setAtgDiscovering(true);
    setAtgDiscovered(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const branch = atgConfig?.branches[0];
      const result = await invoke<AtgDiscoveryResult>(
        "admin_atg_discover",
        {
          port: branch?.port ?? null,
          unitId: branch?.unit_id ?? null,
          startRegister: branch?.start_register ?? null,
          addressBase: branch?.address_base ?? null,
          registerCount: branch?.register_count ?? null,
        },
      );
      setAtgDiscovered(result);
    } catch (e) {
      setInvokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setAtgDiscovering(false);
    }
  };

  const saveAtgConfig = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("admin_save_atg_config", {
        pollIntervalSecs: atgPollInterval,
        modbusTimeoutSecs: atgTimeout,
        apiUrl: atgApiUrl.trim() || null,
        auth: atgConfig?.auth ?? null,
        branches: atgConfig?.branches ?? null,
      });
      await loadAtgConfig();
      setMsg(t("admin.atg.savedMsg"));
    } catch (e) {
      setInvokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveSyncConfig = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("update_sync_config", {
        backendUrl: syncUrl.trim() || null,
        apiKey: syncApiKey.trim() || null,
        retryIntervalSecs: syncRetryInterval,
        batchSize: syncBatchSize,
        maxRetries: syncMaxRetries,
        pricePullIntervalHours: syncPricePullInterval,
        pricePullEnabled: syncPricePullEnabled,
      });
      await loadSyncStatus();
      setMsg(t("admin.sync.savedMsg"));
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
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">{t("admin.title")}</h1>
        <button
          type="button"
          onClick={() => {
            setAdminToken(null);
            onLogout();
          }}
          className="rounded-xl border border-border-primary/80 bg-bg-secondary/80 px-4 py-2 text-sm font-bold text-text-primary shadow-sm transition-all hover:bg-bg-tertiary hover:shadow-button"
        >
          {t("admin.lockAdmin")}
        </button>
      </div>

      {mustChangePin && (
        <div className="rounded-xl border border-accent-amber/40 bg-accent-amber/10 px-4 py-3 text-sm font-semibold text-accent-amber-dark dark:text-accent-amber-light shadow-sm">
          {t("admin.mustChangePinWarning")}
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
          <h2 className="text-lg font-bold text-text-primary">{t("admin.prices.title")}</h2>
          <p className="mt-1 mb-4 text-sm font-medium text-text-secondary">
            {t("admin.prices.description")}
          </p>
          <div className="overflow-x-auto rounded-xl border border-border-primary/60 shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg-secondary/95 text-[10px] font-bold uppercase tracking-wider text-text-muted backdrop-blur-sm">
                <tr>
                  <th className="px-4 py-3">{t("admin.prices.colProduct")}</th>
                  <th className="px-4 py-3">{t("admin.prices.colCurrentPrice")}</th>
                  <th className="px-4 py-3">{t("admin.prices.colNewPrice")}</th>
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
            {t("admin.prices.save")}
          </button>

          <h3 className="mb-2 mt-6 text-[10px] font-bold uppercase tracking-wider text-text-muted">{t("admin.prices.historyTitle")}</h3>
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
          <h2 className="mb-4 text-lg font-bold text-text-primary">{t("admin.operators.title")}</h2>
          <ul className="mb-4 grid gap-3 grid-cols-1">
            {operators.map((op) => (
              <li
                key={op.id}
                className="flex flex-col gap-3 rounded-xl border border-border-primary/60 bg-bg-secondary/40 p-4 shadow-sm transition-colors hover:bg-bg-tertiary/40"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-text-primary">{op.name}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${op.active ? "border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald" : "border-border-secondary bg-bg-secondary text-text-secondary"}`}>
                    {op.active ? t("admin.operators.active") : t("admin.operators.inactive")}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className="text-text-muted">{op.has_pin ? t("admin.operators.pinSet") : t("admin.operators.noPin")}</span>
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
                      {op.active ? t("admin.operators.deactivate") : t("admin.operators.reactivate")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="font-bold text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                      onClick={async () => {
                        const p = window.prompt(t("admin.operators.newPinPrompt"));
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
                      {t("admin.operators.resetPin")}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-3 rounded-xl border border-border-primary/40 bg-bg-secondary/20 p-4">
            <input
              placeholder={t("admin.operators.namePlaceholder")}
              value={newOpName}
              onChange={(e) => setNewOpName(e.target.value)}
              className={`w-full ${inputCls}`}
            />
            <input
              placeholder={t("admin.operators.pinPlaceholder")}
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
              {t("admin.operators.add")}
            </button>
          </div>
        </section>


        <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
          <h2 className="mb-4 text-lg font-bold text-text-primary">{t("admin.shiftSchedule.title")}</h2>
          <select
            value={shiftMode}
            onChange={(e) => setShiftMode(e.target.value as ShiftMode)}
            className={`mb-4 w-full ${inputCls}`}
          >
            <option value="disabled">{t("admin.shiftSchedule.disabled")}</option>
            <option value="manual">{t("admin.shiftSchedule.manual")}</option>
            <option value="scheduled">{t("admin.shiftSchedule.scheduled")}</option>
          </select>
          {shiftMode === "scheduled" && (
            <div className="mb-4 space-y-3">
              {shiftSlots.map((slot, i) => (
                <div key={i} className="flex flex-wrap gap-2 rounded-xl border border-border-primary/40 bg-bg-secondary/20 p-3">
                  <input
                    placeholder={t("admin.shiftSchedule.namePlaceholder")}
                    value={slot.name}
                    onChange={(e) => {
                      const next = [...shiftSlots];
                      next[i] = { ...slot, name: e.target.value };
                      setShiftSlots(next);
                    }}
                    className={`flex-1 ${inputCls}`}
                  />
                  <input
                    placeholder={t("admin.shiftSchedule.startPlaceholder")}
                    value={slot.start}
                    onChange={(e) => {
                      const next = [...shiftSlots];
                      next[i] = { ...slot, start: e.target.value };
                      setShiftSlots(next);
                    }}
                    className={`w-24 ${inputCls}`}
                  />
                  <input
                    placeholder={t("admin.shiftSchedule.endPlaceholder")}
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
                  setShiftSlots([...shiftSlots, { name: t("admin.shiftSchedule.slotDefault"), start: "06:00", end: "14:00" }])
                }
              >
                {t("admin.shiftSchedule.addSlot")}
              </button>
            </div>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={saveShiftSchedule}
            className="rounded-xl border border-border-primary bg-bg-primary px-5 py-2.5 text-sm font-bold text-text-primary shadow-sm hover:bg-bg-tertiary transition-all"
          >
            {t("admin.shiftSchedule.save")}
          </button>
        </section>

        {settings && (
          <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
            <h2 className="mb-4 text-lg font-bold text-text-primary">{t("admin.settings.title")}</h2>
            <div className="grid gap-4 text-sm font-medium">
              <label className="flex flex-col gap-1.5 text-text-secondary">
                {t("admin.settings.pollingInterval")}
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
                {t("admin.settings.offlineThreshold")}
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
                {t("admin.settings.preauthTimeout")}
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
                {t("admin.settings.shiftWarn")}
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
              {t("admin.settings.save")}
            </button>
          </section>
        )}

        <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
          <h2 className="mb-1 text-lg font-bold text-text-primary">{t("admin.display.title")}</h2>
          <p className="mb-5 text-sm font-medium text-text-muted">
            {t("admin.display.description")}
          </p>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between rounded-xl border border-border-primary/60 bg-bg-secondary/60 px-5 py-4 transition-colors hover:bg-bg-tertiary/40">
              <div>
                <p className="text-sm font-bold text-text-primary">{t("admin.display.lightMode")}</p>
                <p className="mt-0.5 text-xs font-medium text-text-muted">
                  {t("admin.display.lightModeDesc")}
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
                <p className="text-sm font-bold text-text-primary">{t("admin.display.smallScreenMode")}</p>
                <p className="mt-0.5 text-xs font-medium text-text-muted">
                  {t("admin.display.smallScreenModeDesc")}
                </p>
              </div>
              <ToggleSwitch
                id="small-screen-toggle"
                checked={smallScreen}
                onChange={setSmallScreen}
              />
            </div>
            <div className="rounded-xl border border-border-primary/60 bg-bg-secondary/60 px-5 py-4 transition-colors hover:bg-bg-tertiary/40">
              <div className="mb-3">
                <p className="text-sm font-bold text-text-primary">{t("admin.display.dispenserLayout")}</p>
                <p className="mt-0.5 text-xs font-medium text-text-muted">
                  {t("admin.display.dispenserLayoutDesc")}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDispenserLayout("modern")}
                  className={`rounded-lg border px-3 py-2 text-left transition-all ${
                    dispenserLayout === "modern"
                      ? "border-accent-blue bg-accent-blue/12 text-text-primary ring-1 ring-accent-blue/25"
                      : "border-border-primary bg-bg-card/50 text-text-secondary hover:bg-bg-tertiary/40"
                  }`}
                >
                  <span className="block text-sm font-bold">{t("admin.display.layoutModern")}</span>
                  <span className="mt-0.5 block text-xs text-text-muted">{t("admin.display.layoutModernDesc")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDispenserLayout("classic")}
                  className={`rounded-lg border px-3 py-2 text-left transition-all ${
                    dispenserLayout === "classic"
                      ? "border-accent-blue bg-accent-blue/12 text-text-primary ring-1 ring-accent-blue/25"
                      : "border-border-primary bg-bg-card/50 text-text-secondary hover:bg-bg-tertiary/40"
                  }`}
                >
                  <span className="block text-sm font-bold">{t("admin.display.layoutClassic")}</span>
                  <span className="mt-0.5 block text-xs text-text-muted">{t("admin.display.layoutClassicDesc")}</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
          <div className="flex items-start justify-between mb-1">
            <h2 className="text-lg font-bold text-text-primary">{t("admin.sync.title")}</h2>
            {syncStatus && (
              <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                syncStatus.connected
                  ? "border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald"
                  : "border-border-secondary bg-bg-secondary text-text-secondary"
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${syncStatus.connected ? "bg-accent-emerald" : "bg-text-secondary"}`} />
                {syncStatus.connected ? t("admin.sync.connected") : t("admin.sync.disconnected")}
              </span>
            )}
          </div>
          <p className="mb-4 text-sm font-medium text-text-muted">{t("admin.sync.description")}</p>

          {syncStatus && (
            <div className="mb-5 rounded-xl border border-border-primary/40 bg-bg-secondary/30 px-4 py-3 text-xs font-medium space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">{t("admin.sync.pending", { count: syncStatus.pending_count })}</span>
                <button
                  type="button"
                  onClick={loadSyncStatus}
                  className="text-accent-blue font-bold hover:text-accent-blue-light transition-colors"
                >
                  {t("admin.sync.refresh")}
                </button>
              </div>
              <p className="text-text-muted">
                {syncStatus.last_sync_at
                  ? t("admin.sync.lastSync", { time: new Date(syncStatus.last_sync_at).toLocaleString() })
                  : t("admin.sync.lastSyncNever")}
              </p>
              {syncStatus.last_error && (
                <p className="text-accent-amber truncate">{t("admin.sync.lastError", { msg: syncStatus.last_error })}</p>
              )}
            </div>
          )}

          {syncStatus && (
            <div className={`mb-4 flex items-center gap-2 rounded-xl border px-4 py-2.5 text-xs font-semibold ${
              syncStatus.enabled
                ? "border-accent-emerald/30 bg-accent-emerald/10 text-accent-emerald"
                : "border-border-secondary bg-bg-secondary/40 text-text-muted"
            }`}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${syncStatus.enabled ? "bg-accent-emerald" : "bg-text-muted"}`} />
              <span>{syncStatus.enabled ? t("admin.sync.enableSync") : t("admin.sync.enableSyncDesc")}</span>
              <span className="ml-auto font-mono text-[10px] opacity-50">enabled={syncStatus.enabled ? "true" : "false"} · site.config.json</span>
            </div>
          )}

          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-text-secondary">
              {t("admin.sync.backendUrl")}
              <input
                type="url"
                className={inputCls}
                placeholder={t("admin.sync.backendUrlPlaceholder")}
                value={syncUrl}
                onChange={(e) => setSyncUrl(e.target.value)}
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-text-secondary">
              {t("admin.sync.apiKey")}
              <div className="relative">
                <input
                  type={showApiKey ? "text" : "password"}
                  className={`w-full pr-10 ${inputCls}`}
                  placeholder={t("admin.sync.apiKeyPlaceholder")}
                  value={syncApiKey}
                  onChange={(e) => setSyncApiKey(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
                  tabIndex={-1}
                >
                  {showApiKey ? "🙈" : "👁"}
                </button>
              </div>
            </label>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                {t("admin.sync.retryInterval")}
                <input
                  type="number"
                  min={5}
                  max={3600}
                  className={inputCls}
                  value={syncRetryInterval}
                  onChange={(e) => setSyncRetryInterval(Number(e.target.value))}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                {t("admin.sync.batchSize")}
                <input
                  type="number"
                  min={1}
                  max={1000}
                  className={inputCls}
                  value={syncBatchSize}
                  onChange={(e) => setSyncBatchSize(Number(e.target.value))}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                {t("admin.sync.maxRetries")}
                <input
                  type="number"
                  min={1}
                  max={100}
                  className={inputCls}
                  value={syncMaxRetries}
                  onChange={(e) => setSyncMaxRetries(Number(e.target.value))}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                {t("admin.sync.pricePullInterval")}
                <input
                  type="number"
                  min={0}
                  max={168}
                  className={inputCls}
                  value={syncPricePullInterval}
                  onChange={(e) => setSyncPricePullInterval(Number(e.target.value))}
                />
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-text-secondary sm:col-span-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent-blue"
                  checked={syncPricePullEnabled}
                  onChange={(e) => setSyncPricePullEnabled(e.target.checked)}
                />
                {t("admin.sync.pricePullEnabled")}
              </label>
            </div>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={saveSyncConfig}
            className="mt-5 rounded-xl border border-accent-blue/40 bg-accent-blue/10 px-5 py-2.5 text-sm font-bold text-accent-blue shadow-sm hover:bg-accent-blue/20 transition-all disabled:opacity-50"
          >
            {t("admin.sync.save")}
          </button>
        </section>

        {atgConfig && (
          <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
            <div className="flex items-start justify-between mb-1">
              <h2 className="text-lg font-bold text-text-primary">{t("admin.atg.title")}</h2>
              <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                atgConfig.enabled
                  ? "border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald"
                  : "border-border-secondary bg-bg-secondary text-text-secondary"
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${atgConfig.enabled ? "bg-accent-emerald animate-pulse" : "bg-text-secondary"}`} />
                {atgConfig.enabled ? t("admin.atg.enabled") : t("admin.atg.disabled")}
              </span>
            </div>
            <p className="mb-5 text-sm font-medium text-text-muted">{t("admin.atg.description")}</p>

            {/* Branch summary */}
            {atgConfig.branches.length > 0 && (
              <div className="mb-5 space-y-2">
                {atgConfig.branches.map((branch) => (
                  <div key={branch.id} className="rounded-xl border border-border-primary/40 bg-bg-secondary/30 px-4 py-3 text-xs font-medium">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-text-primary">{branch.name || `Branch #${branch.id}`}</span>
                      <span className="font-mono text-text-muted">{branch.host}:{branch.port}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {branch.slots.map((slot) => (
                        <span key={slot.slot} className="rounded-full border border-border-primary/50 bg-bg-primary/60 px-2 py-0.5 text-[10px] font-semibold text-text-secondary">
                          {slot.slot}. {slot.type}
                          {slot.product_id != null ? ` (id:${slot.product_id})` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Network discovery */}
            <div className="mb-5 rounded-xl border border-border-primary/40 bg-bg-secondary/20 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-bold uppercase tracking-wider text-text-secondary">{t("admin.atg.discover")}</p>
                <button
                  type="button"
                  disabled={atgDiscovering}
                  onClick={discoverAtg}
                  className="flex items-center gap-1.5 rounded-lg border border-accent-blue/40 bg-accent-blue/10 px-3 py-1.5 text-xs font-bold text-accent-blue hover:bg-accent-blue/20 transition-all disabled:opacity-50"
                >
                  {atgDiscovering ? (
                    <>
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent-blue/30 border-t-accent-blue" />
                      {t("admin.atg.discovering")}
                    </>
                  ) : (
                    t("admin.atg.scanNetwork")
                  )}
                </button>
              </div>
              {atgDiscovered && (
                <div className="mt-2 space-y-1.5">
                  <p className="text-[10px] font-semibold text-text-muted">
                    {t("admin.atg.scannedSubnet", { subnet: `${atgDiscovered.subnet}.0/24`, port: atgDiscovered.port })}
                  </p>
                  {atgDiscovered.found.length === 0 ? (
                    <p className="text-xs font-semibold text-text-muted">{t("admin.atg.noneFound")}</p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {atgDiscovered.found.map((ip) => {
                        const device = atgDiscovered.devices?.find((entry) => entry.host === ip);
                        return (
                          <div key={ip} className="rounded-lg border border-border-primary/50 bg-bg-primary/40 p-2">
                            <button
                              type="button"
                              title={t("admin.atg.useIp")}
                              onClick={() => {
                                const updated = atgConfig ? {
                                  ...atgConfig,
                                  branches: atgConfig.branches.map((b, i) =>
                                    i === 0 ? { ...b, host: ip } : b
                                  ),
                                } : null;
                                setAtgConfig(updated);
                              }}
                              className="rounded-full border border-accent-emerald/40 bg-accent-emerald/10 px-3 py-1 text-xs font-bold text-accent-emerald hover:bg-accent-emerald/20 transition-all"
                            >
                              {ip}
                            </button>
                            {device?.tanks.length ? (
                              <div className="mt-2 space-y-1">
                                {device.tanks.map((tank) => (
                                  <div key={tank.slot} className="rounded-md bg-bg-secondary/50 px-2 py-1 text-[10px] font-semibold text-text-secondary">
                                    <span className="text-text-primary">Tank {tank.slot}</span>
                                    <span className="ml-2">{Math.round(tank.product_volume).toLocaleString()} L</span>
                                    <span className="ml-2">{tank.temperature_c.toFixed(1)}°C</span>
                                    <span className="ml-2">water {Math.round(tank.water_volume).toLocaleString()} L</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="mt-2 text-[10px] font-semibold text-text-muted">
                                {device?.error ? device.error : "No active tanks returned"}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5 text-sm font-medium text-text-secondary">
                  {t("admin.atg.pollInterval")}
                  <input
                    type="number"
                    min={30}
                    max={3600}
                    className={inputCls}
                    value={atgPollInterval}
                    onChange={(e) => setAtgPollInterval(Number(e.target.value))}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium text-text-secondary">
                  {t("admin.atg.modbusTimeout")}
                  <input
                    type="number"
                    min={1}
                    max={60}
                    step={0.5}
                    className={inputCls}
                    value={atgTimeout}
                    onChange={(e) => setAtgTimeout(Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-text-secondary">
                {t("admin.atg.apiUrl")}
                <input
                  type="url"
                  className={inputCls}
                  placeholder={t("admin.atg.apiUrlPlaceholder")}
                  value={atgApiUrl}
                  onChange={(e) => setAtgApiUrl(e.target.value)}
                />
              </label>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                disabled={busy || !atgConfig.enabled}
                onClick={saveAtgConfig}
                className="rounded-xl border border-accent-blue/40 bg-accent-blue/10 px-5 py-2.5 text-sm font-bold text-accent-blue shadow-sm hover:bg-accent-blue/20 transition-all disabled:opacity-50"
              >
                {t("admin.atg.save")}
              </button>
              <span className="font-mono text-[10px] opacity-40 text-text-muted">site.config.json</span>
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm">
          <h2 className="mb-4 text-lg font-bold text-text-primary">{t("admin.changePin.title")}</h2>
          <div className="flex flex-col gap-3">
            <input
              type="password"
              placeholder={t("admin.changePin.currentPin")}
              value={pinCurrent}
              onChange={(e) => setPinCurrent(e.target.value)}
              className={inputCls}
            />
            <input
              type="password"
              placeholder={t("admin.changePin.newPin")}
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
              {t("admin.changePin.update")}
            </button>
          </div>
        </section>
      </div>
    </div>
    </div>
  );
}
