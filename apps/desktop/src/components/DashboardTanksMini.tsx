import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../store";

const fmtInt = new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 0 });

export function DashboardTanksMini() {
  const { t } = useTranslation();
  const siteSnapshot = useAppStore((s) => s.siteSnapshot);

  const rows = useMemo(() => {
    const tanks = siteSnapshot?.tanks ?? [];
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
      ? tanks.filter((t) => activeProductIds.has(t.product_id))
      : tanks;

    return visible.map((tank) => {
      const product = productMap.get(tank.product_id);
      const levelPct = tank.capacity_l > 0
        ? Math.round((tank.current_l / tank.capacity_l) * 100)
        : 0;
      return { ...tank, product, levelPct };
    });
  }, [siteSnapshot]);

  const alertColor = (pct: number) =>
    pct < 10 ? "#ef4444" : pct < 25 ? "#f59e0b" : undefined;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border-primary/70 bg-bg-card/70 shadow-card">
      <header className="flex items-center justify-between gap-2 border-b border-border-primary/60 bg-bg-secondary/40 px-4 py-2.5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-text-primary">{t("reservoirs.title")}</h3>
        <span className="rounded-md border border-border-primary/50 bg-bg-primary/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
          {t("reservoirs.tanks", { n: rows.length })}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden px-3 py-3">
        {rows.length === 0 ? (
          <p className="flex h-full items-center justify-center text-sm text-text-muted">—</p>
        ) : (
          <div className="flex h-full items-stretch gap-2">
            {rows.map((row) => {
              const color = row.product?.color ?? "#6b7280";
              const warn = alertColor(row.levelPct);
              return (
                <div
                  key={row.product_id}
                  className="flex flex-1 flex-col items-center gap-1.5 rounded-xl border border-border-primary/50 bg-bg-primary/40 px-2 py-2"
                >
                  {/* Label + dot */}
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                    <span className="truncate text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                      {row.label}
                    </span>
                  </div>

                  {/* Vertical gauge */}
                  <div className="relative flex flex-1 w-10 flex-col justify-end overflow-hidden rounded-md border border-border-primary/40 bg-bg-secondary/60">
                    <div
                      className="w-full rounded-sm transition-all duration-700"
                      style={{
                        height: `${row.levelPct}%`,
                        backgroundColor: warn ?? color,
                        opacity: 0.85,
                      }}
                    />
                    {/* Percentage label centred in gauge */}
                    <span
                      className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[10px] font-black tabular-nums"
                      style={{ color: warn ?? color }}
                    >
                      {row.levelPct}%
                    </span>
                  </div>

                  {/* Current volume */}
                  <span className="whitespace-nowrap font-mono text-[11px] font-semibold tabular-nums text-text-primary">
                    {fmtInt.format(row.current_l)} L
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
