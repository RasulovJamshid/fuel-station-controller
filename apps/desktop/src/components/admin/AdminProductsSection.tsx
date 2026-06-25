import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AdminCatalog,
  AdminNozzleInput,
  AdminProductInput,
} from "../../types/api";
import { useAppStore } from "../../store";
import { formatMoney, parseMoney } from "../../lib/money";

export interface LiftedNozzle {
  fpId: string;
  nozzleIndex: number;
  productName: string | null;
  productColor: string | null;
}

interface Props {
  token: string;
  onMessage: (msg: string) => void;
  onError: (msg: string) => void;
  /** Reload price table after products/nozzles are persisted. */
  onCatalogChanged?: () => void | Promise<void>;
  liftedNozzles?: LiftedNozzle[];
  /** Current globally-saved price per product_id. Used when saving nozzles so
   *  per-nozzle prices always match the global price setting. */
  productPriceMap?: Record<number, number>;
}

type ProductDraft = AdminProductInput & { _key: string };
type NozzleDraft = AdminNozzleInput;

function newProductDraft(): ProductDraft {
  return {
    _key: crypto.randomUUID(),
    id: null,
    name: "",
    color: "#2196F3",
    unit: "litre",
  };
}

function newNozzleDraft(index: number, productId: number): NozzleDraft {
  return { index, product_id: productId, price: 10500, active: true, wayne_code: 0, wayne_product_code: 0 };
}

export function AdminProductsSection({
  token,
  onMessage,
  onError,
  onCatalogChanged,
  liftedNozzles = [],
  productPriceMap = {},
}: Props) {
  const { t } = useTranslation();
  const setSiteSnapshot = useAppStore((s) => s.setSiteSnapshot);
  const [catalog, setCatalog] = useState<AdminCatalog | null>(null);
  const [products, setProducts] = useState<ProductDraft[]>([]);
  const [positionNozzles, setPositionNozzles] = useState<
    Record<string, NozzleDraft[]>
  >({});
  const [selectedFp, setSelectedFp] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // Tracks whether the initial FP selection has been made so loadCatalog
  // doesn't need selectedFp in its dependency array (which would trigger a
  // full refetch — resetting all draft edits — on every tab switch).
  const didInitSelect = useRef(false);
  // Stable ref so the effect below can call the latest onError without
  // listing it as a dependency (it's an inline arrow in AdminPanel that
  // changes every render, which would otherwise re-trigger the effect).
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; });

  // Auto-switch to the FP tab when a nozzle is newly lifted on it.
  const prevLiftedFpIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(liftedNozzles.map((l) => l.fpId));
    for (const id of currentIds) {
      if (!prevLiftedFpIdsRef.current.has(id)) {
        setSelectedFp(id);
        break;
      }
    }
    prevLiftedFpIdsRef.current = currentIds;
  }, [liftedNozzles]);

  const loadCatalog = useCallback(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const cat = await invoke<AdminCatalog>("admin_get_catalog", { token });
    setCatalog(cat);
    setProducts(
      cat.products.map((p) => ({
        _key: `p-${p.id}`,
        id: p.id,
        name: p.name,
        color: p.color,
        unit: p.unit,
      })),
    );
    const byFp: Record<string, NozzleDraft[]> = {};
    for (const pos of cat.positions) {
      byFp[pos.fp_id] = pos.nozzles.map((n) => ({
        index: n.index,
        product_id: n.product_id,
        price: n.price,
        active: n.active,
        wayne_code: n.wayne_code ?? 0,
        wayne_product_code: n.wayne_product_code ?? 0,
      }));
    }
    setPositionNozzles(byFp);
    if (!didInitSelect.current && cat.positions.length > 0) {
      setSelectedFp(cat.positions[0]!.fp_id);
      didInitSelect.current = true;
    }
  }, [token]);

  useEffect(() => {
    loadCatalog().catch((e) =>
      onErrorRef.current(e instanceof Error ? e.message : String(e)),
    );
  }, [loadCatalog]);

  const refreshConfig = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const snap = await invoke<import("../../types/api").SiteSnapshot>(
      "get_site_config",
    );
    setSiteSnapshot(snap);
  };

  const saveProducts = async () => {
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const payload: AdminProductInput[] = products.map((p) => {
        const name = p.name.trim();
        if (!name) {
          throw new Error(t("admin.products.productRequiresName"));
        }
        const row: AdminProductInput = { name, color: p.color, unit: p.unit };
        if (p.id != null) {
          row.id = p.id;
        }
        return row;
      });
      await invoke("admin_save_products", { token, products: payload });
      onMessage(t("admin.products.savedMsg"));
      // Await both refreshes so the UI reflects the saved state before re-enabling.
      await Promise.all([
        loadCatalog().catch((e) => onError(e instanceof Error ? e.message : String(e))),
        onCatalogChanged?.(),
      ]);
      refreshConfig().catch(() => {});
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveNozzlesForFp = async (fpId: string) => {
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const nozzles = positionNozzles[fpId] ?? [];
      await invoke("admin_save_position_nozzles", {
        token,
        fpId,
        nozzles,
      });
      onMessage(t("admin.products.nozzlesSavedMsg", { fpId }));
      // Await both refreshes so the nozzle table and Prices section both reflect
      // the saved state before re-enabling the button.
      await Promise.all([
        loadCatalog().catch((e) => onError(e instanceof Error ? e.message : String(e))),
        onCatalogChanged?.(),
      ]);
      refreshConfig().catch(() => {});
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const currentPos = catalog?.positions.find((p) => p.fp_id === selectedFp);
  const currentNozzles = positionNozzles[selectedFp] ?? [];
  const defaultProductId = products.find((p) => p.id != null)?.id ?? 3;

  const updateNozzle = (idx: number, patch: Partial<NozzleDraft>) => {
    setPositionNozzles((prev) => {
      const list = [...(prev[selectedFp] ?? [])];
      const i = list.findIndex((n) => n.index === idx);
      if (i < 0) return prev;
      const current = list[i]!;
      // When product changes, auto-suggest price from the global product map
      // if the user hasn't set a custom price for this nozzle yet (price still
      // matches the old product's global price).
      if (patch.product_id !== undefined && patch.product_id !== current.product_id) {
        const suggested = productPriceMap[patch.product_id];
        if (suggested && patch.price === undefined) {
          patch = { ...patch, price: suggested };
        }
      }
      list[i] = { ...current, ...patch };
      return { ...prev, [selectedFp]: list };
    });
  };

  const addNozzle = () => {
    const list = positionNozzles[selectedFp] ?? [];
    const nextIndex =
      list.length === 0 ? 1 : Math.max(...list.map((n) => n.index)) + 1;
    setPositionNozzles((prev) => ({
      ...prev,
      [selectedFp]: [
        ...list,
        newNozzleDraft(nextIndex, defaultProductId as number),
      ],
    }));
  };

  const removeNozzle = (index: number) => {
    setPositionNozzles((prev) => ({
      ...prev,
      [selectedFp]: (prev[selectedFp] ?? []).filter((n) => n.index !== index),
    }));
  };

  const moveNozzle = (nozzleIndex: number, direction: "up" | "down") => {
    setPositionNozzles((prev) => {
      const list = [...(prev[selectedFp] ?? [])].sort((a, b) => a.index - b.index);
      const i = list.findIndex((n) => n.index === nozzleIndex);
      const j = direction === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) return prev;
      const tmp = list[i]!.index;
      list[i] = { ...list[i]!, index: list[j]!.index };
      list[j] = { ...list[j]!, index: tmp };
      list.sort((a, b) => a.index - b.index);
      return { ...prev, [selectedFp]: list };
    });
  };

  const inputCls = "rounded-lg border border-border-primary/80 bg-bg-secondary/60 px-3 py-2 text-sm font-medium text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-blue/50 focus:border-accent-blue/50 transition-all shadow-inner placeholder:text-text-muted";

  return (
    <section className="rounded-2xl border border-border-primary/80 bg-bg-card/80 p-6 shadow-card backdrop-blur-sm mb-6">
      <h2 className="mb-4 text-lg font-bold text-text-primary">
        {t("admin.products.title")}
      </h2>

      <h3 className="mb-1 text-sm font-bold text-text-primary">{t("admin.products.fuelProducts")}</h3>
      <p className="mb-4 text-xs font-medium text-text-muted">
        {t("admin.products.fuelProductsDesc")}
      </p>
      <div className="mb-5 overflow-x-auto rounded-xl border border-border-primary/60 shadow-sm">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-bg-secondary/95 text-[10px] font-bold uppercase tracking-wider text-text-muted backdrop-blur-sm">
            <tr>
              <th className="px-4 py-3">{t("admin.products.colId")}</th>
              <th className="px-4 py-3">{t("admin.products.colName")}</th>
              <th className="px-4 py-3">{t("admin.products.colColor")}</th>
              <th className="px-4 py-3">{t("admin.products.colUnit")}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-secondary/60 bg-bg-card/40">
            {products.map((p, i) => (
              <tr key={p._key} className="transition-colors hover:bg-bg-tertiary/40">
                <td className="px-4 py-3 font-mono text-text-muted font-medium">
                  {p.id ?? "auto"}
                </td>
                <td className="px-4 py-3">
                  <input
                    value={p.name}
                    onChange={(e) => {
                      const next = [...products];
                      next[i] = { ...p, name: e.target.value };
                      setProducts(next);
                    }}
                    className={`w-full ${inputCls}`}
                  />
                </td>
                <td className="px-4 py-3">
                  <input
                    type="color"
                    value={p.color.startsWith("#") ? p.color : "#888888"}
                    onChange={(e) => {
                      const next = [...products];
                      next[i] = { ...p, color: e.target.value };
                      setProducts(next);
                    }}
                    className="h-9 w-14 cursor-pointer rounded-lg border border-border-primary/60 bg-bg-secondary/40 p-0.5"
                  />
                </td>
                <td className="px-4 py-3">
                  <input
                    value={p.unit}
                    onChange={(e) => {
                      const next = [...products];
                      next[i] = { ...p, unit: e.target.value };
                      setProducts(next);
                    }}
                    className={`w-24 ${inputCls}`}
                  />
                </td>
                <td className="px-4 py-3">
                  <button
                    type="button"
                    className="text-xs font-bold text-accent-red transition-colors hover:text-accent-red-light disabled:opacity-50"
                    disabled={busy || products.length <= 1}
                    onClick={() =>
                      setProducts(products.filter((_, j) => j !== i))
                    }
                  >
                    {t("admin.products.remove")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mb-8 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => setProducts([...products, newProductDraft()])}
          className="rounded-xl border border-border-primary bg-bg-primary px-5 py-2 text-sm font-bold text-text-primary shadow-sm hover:bg-bg-tertiary transition-all"
        >
          {t("admin.products.addProduct")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={saveProducts}
          className="rounded-xl border border-accent-amber/40 bg-accent-amber/15 px-5 py-2 text-sm font-bold tracking-wide text-accent-amber shadow-button transition-all hover:bg-accent-amber/25 hover:shadow-button-hover disabled:opacity-50"
        >
          {t("admin.products.saveProducts")}
        </button>
      </div>

      <h3 className="mb-3 text-sm font-bold text-text-primary">
        {t("admin.products.nozzlesTitle")}
      </h3>
      <div className="mb-4 flex flex-wrap gap-2">
        {catalog?.positions.map((pos) => {
          const hasLift = liftedNozzles.some((l) => l.fpId === pos.fp_id);
          return (
            <button
              key={pos.fp_id}
              type="button"
              onClick={() => setSelectedFp(pos.fp_id)}
              className={[
                "relative rounded-xl px-4 py-2 text-sm font-bold transition-all",
                selectedFp === pos.fp_id
                  ? "bg-accent-blue text-text-inverse shadow-button"
                  : "border border-border-primary/60 bg-bg-secondary/40 text-text-secondary hover:bg-bg-tertiary/40 hover:text-text-primary",
              ].join(" ")}
            >
              {pos.fp_id}
              {hasLift && (
                <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-emerald opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent-emerald" />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {currentPos && (
        <div>
          <p className="mb-3 text-sm font-medium text-text-muted">{currentPos.label}</p>

          {liftedNozzles
            .filter((l) => l.fpId === selectedFp)
            .map((l) => {
              const configured = currentNozzles.find((n) => n.index === l.nozzleIndex);
              const configuredProduct = configured
                ? products.find((p) => p.id === configured.product_id)
                : null;
              const mismatch =
                l.productName != null &&
                configuredProduct != null &&
                l.productName !== configuredProduct.name;
              return (
                <div
                  key={l.nozzleIndex}
                  className="mb-4 flex items-start gap-3 rounded-xl border border-accent-emerald/40 bg-accent-emerald/10 px-4 py-3 text-sm shadow-sm"
                >
                  <span className="mt-1 flex h-2.5 w-2.5 shrink-0">
                    <span className="inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-accent-emerald opacity-75" />
                  </span>
                  <div>
                    <span className="font-bold text-accent-emerald-dark dark:text-accent-emerald-light">
                      {t("admin.products.nozzleLifted", { n: l.nozzleIndex })}
                    </span>
                    {l.productName && (
                      <span className="text-text-secondary font-medium">
                        {" "}— {t("admin.products.hardwareReports", { name: l.productName })}
                      </span>
                    )}
                    {mismatch && (
                      <span className="ml-1 font-bold text-accent-amber">
                        ({t("admin.products.configuredAs", { configured: configuredProduct!.name })})
                      </span>
                    )}
                    {!mismatch && configuredProduct && (
                      <span className="ml-1 text-text-muted font-medium">
                        — {t("admin.products.matchesConfigured")}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

          <div className="mb-5 overflow-x-auto rounded-xl border border-border-primary/60 shadow-sm">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="bg-bg-secondary/95 text-[10px] font-bold uppercase tracking-wider text-text-muted backdrop-blur-sm">
                <tr>
                  <th className="px-4 py-3">{t("admin.products.colNo")}</th>
                  <th className="px-4 py-3">{t("admin.products.colProduct")}</th>
                  <th className="px-4 py-3">{t("admin.products.colPrice")}</th>
                  <th className="px-4 py-3">{t("admin.products.colActive")}</th>
                  <th className="px-4 py-3">{t("admin.products.colHwCode")}</th>
                  <th className="px-4 py-3">{t("admin.products.colPpCode")}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border-secondary/60 bg-bg-card/40">
                {[...currentNozzles].sort((a, b) => a.index - b.index).map((n, _i, sorted) => {
                  const isLifted = liftedNozzles.some(
                    (l) => l.fpId === selectedFp && l.nozzleIndex === n.index,
                  );
                  const isFirst = sorted[0]!.index === n.index;
                  const isLast = sorted[sorted.length - 1]!.index === n.index;
                  return (
                  <tr
                    key={n.index}
                    className={[
                      "transition-colors",
                      isLifted
                        ? "bg-accent-emerald/10 ring-1 ring-inset ring-accent-emerald/40"
                        : "hover:bg-bg-tertiary/40",
                    ].join(" ")}
                  >
                    <td className="px-4 py-3 font-mono text-text-primary font-bold">
                      <span className="flex items-center gap-2">
                        <span className="flex flex-col gap-0.5">
                          <button
                            type="button"
                            disabled={busy || isFirst}
                            onClick={() => moveNozzle(n.index, "up")}
                            className="flex h-4 w-4 items-center justify-center rounded text-text-muted hover:text-accent-blue disabled:opacity-20"
                            title="Move up"
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            disabled={busy || isLast}
                            onClick={() => moveNozzle(n.index, "down")}
                            className="flex h-4 w-4 items-center justify-center rounded text-text-muted hover:text-accent-blue disabled:opacity-20"
                            title="Move down"
                          >
                            ▼
                          </button>
                        </span>
                        <span className="w-4 text-center">{n.index}</span>
                        {isLifted && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-accent-emerald px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white animate-pulse">
                            {t("admin.products.lifted")}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={n.product_id}
                        onChange={(e) =>
                          updateNozzle(n.index, {
                            product_id: Number(e.target.value),
                          })
                        }
                        className={inputCls}
                      >
                        {products
                          .filter((p) => p.id != null)
                          .map((p) => (
                            <option key={p.id} value={p.id!}>
                              {p.name} (id {p.id})
                            </option>
                          ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={formatMoney(n.price)}
                        onChange={(e) =>
                          updateNozzle(n.index, {
                            price: Math.max(1, Math.trunc(parseMoney(e.target.value)) || 1),
                          })
                        }
                        className={`w-28 font-mono ${inputCls}`}
                        title="Price per litre for this nozzle"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={n.active}
                        onChange={(e) =>
                          updateNozzle(n.index, { active: e.target.checked })
                        }
                        className="h-4 w-4 rounded border-border-primary bg-bg-secondary text-accent-blue focus:ring-accent-blue/50 focus:ring-2 focus:ring-offset-1 focus:ring-offset-bg-primary cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        min={0}
                        max={255}
                        value={n.wayne_code}
                        onChange={(e) =>
                          updateNozzle(n.index, {
                            wayne_code: Math.max(0, Math.min(255, parseInt(e.target.value, 10) || 0)),
                          })
                        }
                        placeholder="0"
                        title="0 = auto-match by slot position"
                        className={`w-20 font-mono ${inputCls}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        min={0}
                        max={255}
                        value={n.wayne_product_code}
                        onChange={(e) =>
                          updateNozzle(n.index, {
                            wayne_product_code: Math.max(0, Math.min(255, parseInt(e.target.value, 10) || 0)),
                          })
                        }
                        placeholder="0"
                        title="Wayne PP byte in CONFIG frame — identifies the fuel grade to the pump."
                        className={`w-20 font-mono ${inputCls}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="text-xs font-bold text-accent-red transition-colors hover:text-accent-red-light disabled:opacity-50"
                        disabled={busy || currentNozzles.length <= 1}
                        onClick={() => removeNozzle(n.index)}
                      >
                        {t("admin.products.remove")}
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={addNozzle}
              className="rounded-xl border border-border-primary bg-bg-primary px-5 py-2 text-sm font-bold text-text-primary shadow-sm hover:bg-bg-tertiary transition-all"
            >
              {t("admin.products.addNozzle")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => saveNozzlesForFp(selectedFp)}
              className="rounded-xl border border-accent-amber/40 bg-accent-amber/15 px-5 py-2 text-sm font-bold tracking-wide text-accent-amber shadow-button transition-all hover:bg-accent-amber/25 hover:shadow-button-hover disabled:opacity-50"
            >
              {t("admin.products.saveNozzles", { fpId: selectedFp })}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
