const fmtInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function StatsPanel(props: { lanes: number; liters: number; sumM: number }) {
  const fmt = new Intl.NumberFormat("uz-UZ");
  const cards = [
    {
      label: "Lanes",
      hint: "Configured positions on site",
      value: fmtInt.format(props.lanes),
      accent: "from-indigo-950/80 to-slate-900/40 ring-indigo-500/25",
    },
    {
      label: "Live volume",
      hint: "Sum of lane meters (litres)",
      value: `${fmt.format(props.liters)} L`,
      accent: "from-emerald-950/80 to-slate-900/40 ring-emerald-500/25",
    },
    {
      label: "Live amount",
      hint: "Sum of lane totals (millions, minor units)",
      value: `${props.sumM.toFixed(2)}M`,
      accent: "from-amber-950/80 to-slate-900/40 ring-amber-500/25",
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-slate-100">Today</h2>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
          Snapshot from live lane totals shown on the dispensers tab. This is not a closed accounting
          report; use History for completed transactions.
        </p>
      </div>

      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-4 md:grid-cols-3">
        {cards.map((c) => (
          <div
            key={c.label}
            className={`flex min-h-[10.5rem] flex-col justify-between rounded-2xl border border-slate-800/90 bg-gradient-to-br p-6 ring-1 ${c.accent}`}
          >
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{c.label}</div>
              <div className="mt-1 text-xs text-slate-500">{c.hint}</div>
            </div>
            <div className="mt-4 font-mono text-3xl font-semibold tabular-nums tracking-tight text-white sm:text-4xl">
              {c.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
