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

    const visible = activeProductIds.size > 0
      ? allTanks.filter((t) => activeProductIds.has(t.product_id))
      : allTanks;

    return visible.map((tank, i) => ({
      ...tank,
      product: productMap.get(tank.product_id),
      levelPct: tank.capacity_l > 0
        ? Math.round((tank.current_l / tank.capacity_l) * 100)
        : 0,
      tone: TONE_ORDER[i % TONE_ORDER.length],
    }));
  }, [siteSnapshot]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[36px] border border-border-primary/60 bg-gradient-to-br from-bg-card/95 via-bg-card/85 to-bg-primary/70 shadow-[0_32px_60px_rgba(5,10,20,0.55)]">
        <div className="flex flex-wrap items-center gap-4 border-b border-border-primary/60 bg-gradient-to-r from-bg-secondary/80 via-bg-tertiary/30 to-bg-secondary/70 px-6 py-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-3xl border border-border-primary/60 bg-bg-primary/90 shadow-inner">
            <img src={dropletIcon} alt="" className="h-5 w-5 opacity-80" draggable={false} />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.45em] text-text-tertiary">{t("reservoirs.subtitle")}</p>
            <h2 className="text-2xl font-black uppercase tracking-[0.2em] text-text-primary">{t("reservoirs.title")}</h2>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden items-center gap-3 rounded-2xl border border-border-primary/50 bg-bg-primary/70 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.3em] text-text-secondary sm:flex">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent-emerald" aria-hidden />
              {t("reservoirs.live")}
              <span className="ml-2 rounded-full border border-border-primary/40 px-2 py-0.5 text-xs text-text-primary">
                {t("reservoirs.tanks", { n: tanks.length })}
              </span>
            </div>
            <button className="flex items-center justify-center rounded-2xl border border-border-primary/50 bg-bg-secondary/50 px-5 py-2 text-xs font-bold uppercase tracking-widest text-text-primary shadow-sm transition-all hover:bg-bg-tertiary hover:text-text-primary active:scale-95">
              {t("reservoirs.settings")}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
          {tanks.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">—</div>
          ) : (
            <div className="grid auto-rows-fr gap-5 md:grid-cols-2 xl:grid-cols-3">
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
