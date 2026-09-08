import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { TankGauge } from "./TankGauge";
import { useAppStore } from "../store";
import dropletIcon from "@/assets/icons/fuel.svg";

const TONE_ORDER = ["emerald", "amber", "blue"] as const;

export function ReservoirsPanel() {
  const { t } = useTranslation();
  const siteSnapshot = useAppStore((s) => s.siteSnapshot);

  const tanks = useMemo(() => {
    const allTanks = siteSnapshot?.tanks ?? [];
    const products = siteSnapshot?.products ?? [];
    const productMap = new Map(products.map((p) => [p.id, p]));

    const activeProductIds = new Set(
      (siteSnapshot?.positions ?? [])
        .filter((p) => p.active)
        .flatMap((p) => p.nozzles)
        .filter((n) => n.active)
        .map((n) => n.product_id),
    );

    const liveTanks = allTanks.filter((t) => t.updated_at_ms != null);
    const visible = activeProductIds.size > 0
      ? liveTanks.filter((t) => activeProductIds.has(t.product_id))
      : liveTanks;

    const clampPct = (value: number) =>
      Math.max(0, Math.min(100, Math.round(value)));

    return visible.map((tank, i) => ({
      ...tank,
      product: productMap.get(tank.product_id),
      levelPct: tank.capacity_l > 0
        ? clampPct((tank.current_l / tank.capacity_l) * 100)
        : 0,
      tone: TONE_ORDER[i % TONE_ORDER.length],
    }));
  }, [siteSnapshot]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-primary/60 bg-bg-card">
        <div className="flex flex-wrap items-center gap-3 border-b border-border-primary/60 bg-bg-secondary/40 px-5 py-3.5">
          <div className="flex h-9 w-9 items-center justify-center rounded border border-border-primary/50 bg-bg-primary">
            <img src={dropletIcon} alt="" className="h-4 w-4 opacity-70" draggable={false} />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-text-primary">{t("reservoirs.title")}</h2>
            <p className="mt-0.5 text-xs text-text-tertiary">{t("reservoirs.subtitle")}</p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden items-center gap-2 text-xs text-text-secondary sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-emerald" aria-hidden />
              {t("reservoirs.live")}
              <span className="border-l border-border-primary/60 pl-2 font-medium tabular-nums text-text-primary">
                {t("reservoirs.tanks", { n: tanks.length })}
              </span>
            </div>
            <button className="flex items-center justify-center rounded border border-border-primary/60 bg-bg-primary px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40">
              {t("reservoirs.settings")}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tanks.length === 0 ? (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-2 rounded border border-dashed border-border-primary/50 bg-bg-primary/35 px-6 text-center">
              <p className="text-sm font-semibold text-text-primary">
                {t("reservoirs.noLiveData")}
              </p>
              <p className="max-w-md text-xs leading-5 text-text-muted">
                {t("reservoirs.noLiveHint")}
              </p>
            </div>
          ) : (
            <div className="grid auto-rows-fr gap-4 md:grid-cols-2 xl:grid-cols-3">
              {tanks.map((tank) => (
                <TankGauge
                  key={tank.product_id}
                  label={tank.label}
                  levelPct={tank.levelPct}
                  currentL={tank.current_l}
                  capacityL={tank.capacity_l}
                  temperatureC={tank.temperature_c}
                  waterL={tank.water_l}
                  updatedAtMs={tank.updated_at_ms}
                  tone={tank.tone}
                  subtitle={tank.product?.name}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
