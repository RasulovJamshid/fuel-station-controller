export function TankGauge(props: {
  label: string;
  levelPct: number;
  subtitle: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, props.levelPct));
  return (
    <div
      className={`flex min-h-[11rem] flex-1 flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-4 shadow-inner shadow-black/20 ${props.className ?? ""}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-slate-100">{props.label}</span>
        <span className="font-mono text-xs text-sky-400/90">{pct}%</span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-slate-800/90 ring-1 ring-slate-700/50">
        <div
          className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-sky-800 to-sky-500 transition-all duration-500"
          style={{ height: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-slate-400">{props.subtitle}</div>
    </div>
  );
}
