import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { FpState, NozzleSnapshot } from "../types/api";

const fmtSum = new Intl.NumberFormat("uz-UZ");
const fmtVol = new Intl.NumberFormat("uz-UZ", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

type NozzleTotals = {
  volume: number | null;
  amount: number | null;
  price: number | null;
};

/** Lifetime totals for one nozzle: prefer the per-nozzle entry, fall back to the
 *  legacy single-nozzle fields. Returns null when the pump reported no totals. */
function totalsFor(state: FpState, nozzleIndex: number): NozzleTotals | null {
  const match = state.pump_totals?.find((t) => t.nozzle_index === nozzleIndex);
  if (match) {
    return { volume: match.volume, amount: match.amount, price: match.price };
  }
  if (
    state.pump_total_nozzle_index === nozzleIndex &&
    (state.pump_total_volume != null || state.pump_total_amount != null)
  ) {
    return {
      volume: state.pump_total_volume ?? null,
      amount: state.pump_total_amount ?? null,
      price: state.pump_total_price ?? null,
    };
  }
  return null;
}

function pumpTitle(state: FpState): string {
  const label = state.label?.trim();
  if (label) return label;
  const n = state.fp_id.match(/\d+/)?.[0];
  return n ? `${n}-KOLONKA` : state.fp_id;
}

type PumpRow = {
  state: FpState;
  nozzles: Array<{ nozzle: NozzleSnapshot; totals: NozzleTotals | null }>;
  volumeSum: number;
  amountSum: number;
  hasAny: boolean;
};

export function TotalizerPanel({
  states,
  nozzlesByFp,
}: {
  states: FpState[];
  nozzlesByFp: Map<string, NozzleSnapshot[]>;
}) {
  const { t } = useTranslation();

  const pumps = useMemo<PumpRow[]>(() => {
    return states.map((state) => {
      const configured = (nozzlesByFp.get(state.fp_id) ?? []).filter((n) => n.active);
      // Fall back to whatever nozzles totals exist for, if the config has none active.
      const indices =
        configured.length > 0
          ? configured.map((n) => n.index)
          : (state.pump_totals ?? []).map((tt) => tt.nozzle_index);
      const nozzles = indices.map((index) => {
        const nozzle =
          configured.find((n) => n.index === index) ??
          ({
            index,
            product_id: 0,
            product_name: `#${index}`,
            product_color: "#64748b",
            price: 0,
            active: true,
          } as NozzleSnapshot);
        return { nozzle, totals: totalsFor(state, index) };
      });
      const volumeSum = nozzles.reduce((acc, n) => acc + (n.totals?.volume ?? 0), 0);
      const amountSum = nozzles.reduce((acc, n) => acc + (n.totals?.amount ?? 0), 0);
      const hasAny = nozzles.some((n) => n.totals != null);
      return { state, nozzles, volumeSum, amountSum, hasAny };
    });
  }, [states, nozzlesByFp]);

  const station = useMemo(() => {
    return pumps.reduce(
      (acc, p) => ({ volume: acc.volume + p.volumeSum, amount: acc.amount + p.amountSum }),
      { volume: 0, amount: 0 },
    );
  }, [pumps]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-black uppercase tracking-wide text-text-primary">
            {t("totalizer.title")}
          </h1>
          <p className="text-sm text-text-muted">{t("totalizer.subtitle")}</p>
        </div>
        <div className="flex items-stretch gap-2">
          <div className="rounded-xl border border-border-primary/60 bg-bg-card px-4 py-2 text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
              {t("totalizer.stationVolume")}
            </p>
            <p className="font-mono text-lg font-black tabular-nums text-text-primary">
              {fmtVol.format(station.volume)} <span className="text-sm text-text-muted">L</span>
            </p>
          </div>
          <div className="rounded-xl border border-border-primary/60 bg-bg-card px-4 py-2 text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
              {t("totalizer.stationAmount")}
            </p>
            <p className="font-mono text-lg font-black tabular-nums text-accent-blue">
              {fmtSum.format(station.amount)}
            </p>
          </div>
        </div>
      </div>

      {/* Pump grid */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {pumps.map(({ state, nozzles, volumeSum, amountSum, hasAny }) => (
            <div
              key={state.fp_id}
              className="flex flex-col overflow-hidden rounded-xl border border-border-primary bg-bg-card"
            >
              {/* Pump header */}
              <div className="flex items-center justify-between border-b border-border-primary/40 bg-bg-secondary/30 px-4 py-2.5">
                <h2 className="truncate text-sm font-black uppercase tracking-wider text-text-primary">
                  {pumpTitle(state)}
                </h2>
                <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                  {t("totalizer.nozzleCount", { count: nozzles.length })}
                </span>
              </div>

              {/* Column labels */}
              <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-4 pt-2 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                <span>{t("totalizer.product")}</span>
                <span className="text-right">{t("totalizer.volume")}</span>
                <span className="w-28 text-right">{t("totalizer.amount")}</span>
              </div>

              {/* Nozzle rows */}
              <div className="flex flex-col divide-y divide-border-primary/25 px-4 py-1">
                {hasAny ? (
                  nozzles.map(({ nozzle, totals }) => (
                    <div
                      key={nozzle.index}
                      className="grid grid-cols-[1fr_auto_auto] items-center gap-3 py-2"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full border border-border-primary/40"
                          style={{ backgroundColor: nozzle.product_color }}
                        />
                        <span className="min-w-0 truncate text-sm font-semibold text-text-primary">
                          {nozzle.product_name}
                        </span>
                        <span className="shrink-0 text-[10px] font-bold uppercase text-text-muted">
                          · {t("totalizer.nozzle")} {nozzle.index}
                        </span>
                      </span>
                      <span className="text-right font-mono text-sm font-bold tabular-nums text-text-secondary">
                        {totals?.volume != null ? `${fmtVol.format(totals.volume)} L` : "—"}
                      </span>
                      <span className="w-28 text-right font-mono text-sm tabular-nums text-text-muted">
                        {totals?.amount != null ? fmtSum.format(totals.amount) : "—"}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="py-3 text-center text-xs text-text-muted">
                    {t("totalizer.noData")}
                  </p>
                )}
              </div>

              {/* Pump subtotal */}
              {hasAny && (
                <div className="mt-auto grid grid-cols-[1fr_auto_auto] items-center gap-3 border-t border-border-primary/40 bg-bg-secondary/20 px-4 py-2">
                  <span className="text-[10px] font-black uppercase tracking-wider text-text-muted">
                    {t("totalizer.pumpTotal")}
                  </span>
                  <span className="text-right font-mono text-sm font-black tabular-nums text-text-primary">
                    {fmtVol.format(volumeSum)} L
                  </span>
                  <span className="w-28 text-right font-mono text-sm font-black tabular-nums text-accent-blue">
                    {fmtSum.format(amountSum)}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
