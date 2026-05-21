import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdminCatalog,
  AdminNozzleInput,
  AdminProductInput,
} from "../../types/api";
import { useAppStore } from "../../store";

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
  return { index, product_id: productId, price: 10500, active: true, wayne_code: 0 };
}

export function AdminProductsSection({
  token,
  onMessage,
  onError,
  onCatalogChanged,
  liftedNozzles = [],
  productPriceMap = {},
}: Props) {
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
          throw new Error("Every product must have a name.");
        }
        const row: AdminProductInput = { name, color: p.color, unit: p.unit };
        if (p.id != null) {
          row.id = p.id;
        }
        return row;
      });
      await invoke("admin_save_products", { token, products: payload });
      onMessage("Products saved.");
      loadCatalog().catch((e) => onError(e instanceof Error ? e.message : String(e)));
      refreshConfig().catch(() => {});
      Promise.resolve(onCatalogChanged?.()).catch(() => {});
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
      // Stamp each nozzle with the current global product price so that
      // saving nozzle assignments never silently overrides a price change.
      const nozzles = (positionNozzles[fpId] ?? []).map((n) => ({
        ...n,
        price: productPriceMap[n.product_id] ?? n.price,
      }));
      await invoke("admin_save_position_nozzles", {
        token,
        fpId,
        nozzles,
      });
      onMessage(`Nozzles saved for ${fpId}.`);
      loadCatalog().catch((e) => onError(e instanceof Error ? e.message : String(e)));
      refreshConfig().catch(() => {});
      Promise.resolve(onCatalogChanged?.()).catch(() => {});
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
      if (i >= 0) list[i] = { ...list[i]!, ...patch };
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

  const inputCls = "rounded border border-border-primary bg-bg-input px-2 py-1 text-sm text-text-primary focus:outline-none focus:border-border-focus";

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-medium text-amber-400">
        Products &amp; nozzles
      </h2>

      <h3 className="mb-2 text-sm font-medium text-slate-300">Fuel products</h3>
      <p className="mb-2 text-xs text-slate-500">
        Define grades available at the station. Assign them to nozzles per
        dispenser side below.
      </p>
      <div className="mb-3 overflow-x-auto rounded-lg border border-border-primary">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-bg-secondary text-text-muted">
            <tr>
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Color</th>
              <th className="px-3 py-2">Unit</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {products.map((p, i) => (
              <tr key={p._key} className="border-t border-border-primary">
                <td className="px-3 py-2 font-mono text-text-muted">
                  {p.id ?? "auto"}
                </td>
                <td className="px-3 py-2">
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
                <td className="px-3 py-2">
                  <input
                    type="color"
                    value={p.color.startsWith("#") ? p.color : "#888888"}
                    onChange={(e) => {
                      const next = [...products];
                      next[i] = { ...p, color: e.target.value };
                      setProducts(next);
                    }}
                    className="h-8 w-12 cursor-pointer rounded border border-border-primary"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    value={p.unit}
                    onChange={(e) => {
                      const next = [...products];
                      next[i] = { ...p, unit: e.target.value };
                      setProducts(next);
                    }}
                    className={`w-20 ${inputCls}`}
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="text-xs text-red-400 hover:underline"
                    disabled={busy || products.length <= 1}
                    onClick={() =>
                      setProducts(products.filter((_, j) => j !== i))
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mb-6 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => setProducts([...products, newProductDraft()])}
          className="rounded-lg border border-border-primary px-3 py-1.5 text-sm text-text-primary hover:bg-bg-secondary"
        >
          Add product
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={saveProducts}
          className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-500"
        >
          Save products
        </button>
      </div>

      <h3 className="mb-2 text-sm font-medium text-slate-300">
        Nozzles per dispenser side
      </h3>
      <div className="mb-2 flex flex-wrap gap-2">
        {catalog?.positions.map((pos) => {
          const hasLift = liftedNozzles.some((l) => l.fpId === pos.fp_id);
          return (
            <button
              key={pos.fp_id}
              type="button"
              onClick={() => setSelectedFp(pos.fp_id)}
              className={[
                "relative rounded-lg px-3 py-1.5 text-sm",
                selectedFp === pos.fp_id
                  ? "bg-sky-700 text-white"
                  : "border border-border-primary text-text-secondary hover:bg-bg-secondary",
              ].join(" ")}
            >
              {pos.fp_id}
              {hasLift && (
                <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {currentPos && (
        <div>
          <p className="mb-2 text-sm text-text-secondary">{currentPos.label}</p>

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
                  className="mb-3 flex items-start gap-2 rounded-lg border border-emerald-700/60 bg-emerald-950/30 px-3 py-2 text-sm"
                >
                  <span className="mt-0.5 flex h-2 w-2 shrink-0">
                    <span className="inline-flex h-2 w-2 animate-ping rounded-full bg-emerald-400 opacity-75" />
                  </span>
                  <div>
                    <span className="font-medium text-emerald-300">
                      Nozzle #{l.nozzleIndex} is lifted
                    </span>
                    {l.productName && (
                      <span className="text-text-secondary">
                        {" "}— hardware reports <span className="font-mono">{l.productName}</span>
                      </span>
                    )}
                    {mismatch && (
                      <span className="ml-1 font-medium text-amber-400">
                        (configured as {configuredProduct!.name} — edit the row below to correct)
                      </span>
                    )}
                    {!mismatch && configuredProduct && (
                      <span className="ml-1 text-text-muted">
                        — matches configured product
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

          <div className="mb-3 overflow-x-auto rounded-lg border border-border-primary">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-bg-secondary text-text-muted">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">Active</th>
                  <th className="px-3 py-2">
                    <span title="Wayne hardware nozzle byte sent in NozzleUp frame. 0 = auto-match by slot position.">
                      HW Code
                    </span>
                  </th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {currentNozzles.map((n) => {
                  const isLifted = liftedNozzles.some(
                    (l) => l.fpId === selectedFp && l.nozzleIndex === n.index,
                  );
                  return (
                  <tr
                    key={n.index}
                    className={[
                      "border-t border-border-primary",
                      isLifted
                        ? "bg-emerald-950/40 ring-1 ring-inset ring-emerald-500/40"
                        : "",
                    ].join(" ")}
                  >
                    <td className="px-3 py-2 font-mono text-text-primary">
                      <span className="flex items-center gap-1.5">
                        {n.index}
                        {isLifted && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-600/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white animate-pulse">
                            LIFTED
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2">
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
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={n.active}
                        onChange={(e) =>
                          updateNozzle(n.index, { active: e.target.checked })
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
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
                        className={`w-16 font-mono ${inputCls}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="text-xs text-red-400 hover:underline"
                        disabled={busy || currentNozzles.length <= 1}
                        onClick={() => removeNozzle(n.index)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={addNozzle}
              className="rounded-lg border border-border-primary px-3 py-1.5 text-sm text-text-primary hover:bg-bg-secondary"
            >
              Add nozzle
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => saveNozzlesForFp(selectedFp)}
              className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-500"
            >
              Save nozzles for {selectedFp}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
