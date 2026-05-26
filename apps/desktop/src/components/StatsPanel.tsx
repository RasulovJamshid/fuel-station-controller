const fmtInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function StatsPanel(props: { lanes: number; liters: number; sumM: number }) {
  const fmt = new Intl.NumberFormat("uz-UZ");
  const cards = [
    {
      label: "Lanes",
      hint: "Configured positions on site",
      value: fmtInt.format(props.lanes),
      accent: "from-accent-blue/15 to-bg-card ring-accent-blue/40 text-accent-blue",
    },
    {
      label: "Live volume",
      hint: "Sum of lane meters (litres)",
      value: `${fmt.format(props.liters)} L`,
      accent: "from-accent-emerald/15 to-bg-card ring-accent-emerald/40 text-accent-emerald-light",
    },
    {
      label: "Live amount",
      hint: "Sum of lane totals (millions, minor units)",
      value: `${props.sumM.toFixed(2)}M`,
      accent: "from-accent-amber/15 to-bg-card ring-accent-amber/40 text-accent-amber-light",
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <div>
        <h2 className="text-lg font-bold text-text-primary">Today</h2>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
          Snapshot from live lane totals shown on the dispensers tab. This is not a closed accounting
          report; use History for completed transactions.
        </p>
      </div>

      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-4 md:grid-cols-3">
        {cards.map((c) => {
          const textColor = c.accent.split(' ').find(cls => cls.startsWith('text-'));
          return (
            <div
              key={c.label}
              className={`flex min-h-[10.5rem] flex-col justify-between rounded-2xl border border-border-primary/60 bg-gradient-to-br p-6 ring-1 shadow-card backdrop-blur-sm ${c.accent}`}
            >
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-text-primary">{c.label}</div>
                <div className="mt-1 text-xs font-medium text-text-tertiary">{c.hint}</div>
              </div>
              <div className={`mt-4 font-mono text-3xl font-black tabular-nums tracking-tight sm:text-4xl ${textColor}`}>
                {c.value}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
