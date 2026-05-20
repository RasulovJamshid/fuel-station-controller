import { useCallback, useEffect, useState } from "react";
import type {
  AdminCatalog,
  AdminNozzleInput,
  AdminProductInput,
} from "../../types/api";
import { useAppStore } from "../../store";

interface Props {
  token: string;
  onMessage: (msg: string) => void;
  onError: (msg: string) => void;
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
  return { index, product_id: productId, price: 10500, active: true };
}

export function AdminProductsSection({ token, onMessage, onError }: Props) {
  const setSiteSnapshot = useAppStore((s) => s.setSiteSnapshot);
  const [catalog, setCatalog] = useState<AdminCatalog | null>(null);
  const [products, setProducts] = useState<ProductDraft[]>([]);
  const [positionNozzles, setPositionNozzles] = useState<
    Record<string, NozzleDraft[]>
  >({});
  const [selectedFp, setSelectedFp] = useState<string>("");
  const [busy, setBusy] = useState(false);

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
      }));
    }
    setPositionNozzles(byFp);
    if (!selectedFp && cat.positions.length > 0) {
      setSelectedFp(cat.positions[0]!.fp_id);
    }
  }, [token, selectedFp]);

  useEffect(() => {
    loadCatalog().catch((e) =>
      onError(e instanceof Error ? e.message : String(e)),
    );
  }, [loadCatalog, onError]);

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
      const payload: AdminProductInput[] = products.map((p) => ({
        id: p.id ?? undefined,
        name: p.name,
        color: p.color,
        unit: p.unit,
      }));
      await invoke("admin_save_products", { token, products: payload });
      await loadCatalog();
      await refreshConfig();
      onMessage("Products saved.");
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
      await loadCatalog();
      await refreshConfig();
      onMessage(`Nozzles saved for ${fpId}.`);
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
      <div className="mb-3 overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-slate-800/80 text-slate-400">
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
              <tr key={p._key} className="border-t border-slate-700/80">
                <td className="px-3 py-2 font-mono text-slate-400">
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
                    className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1"
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
                    className="h-8 w-12 cursor-pointer rounded border border-slate-600"
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
                    className="w-20 rounded border border-slate-600 bg-slate-800 px-2 py-1"
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
          className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
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
        {catalog?.positions.map((pos) => (
          <button
            key={pos.fp_id}
            type="button"
            onClick={() => setSelectedFp(pos.fp_id)}
            className={[
              "rounded-lg px-3 py-1.5 text-sm",
              selectedFp === pos.fp_id
                ? "bg-sky-700 text-white"
                : "border border-slate-600 text-slate-300 hover:bg-slate-800",
            ].join(" ")}
          >
            {pos.fp_id}
          </button>
        ))}
      </div>

      {currentPos && (
        <div>
          <p className="mb-2 text-sm text-slate-400">{currentPos.label}</p>
          <div className="mb-3 overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-slate-800/80 text-slate-400">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Active</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {currentNozzles.map((n) => (
                  <tr key={n.index} className="border-t border-slate-700/80">
                    <td className="px-3 py-2 font-mono">{n.index}</td>
                    <td className="px-3 py-2">
                      <select
                        value={n.product_id}
                        onChange={(e) =>
                          updateNozzle(n.index, {
                            product_id: Number(e.target.value),
                          })
                        }
                        className="rounded border border-slate-600 bg-slate-800 px-2 py-1"
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
                        type="number"
                        value={n.price}
                        onChange={(e) =>
                          updateNozzle(n.index, {
                            price: parseInt(e.target.value, 10) || 0,
                          })
                        }
                        className="w-28 rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono"
                      />
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
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={addNozzle}
              className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
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
