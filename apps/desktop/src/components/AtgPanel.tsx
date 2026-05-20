const rows = [
  { tank: "Tank 1", product: "AI-92", level: "15,600 L" },
  { tank: "Tank 2", product: "AI-95", level: "8,400 L" },
  { tank: "Tank 3", product: "Diesel", level: "13,000 L" },
];

export function AtgPanel({ className = "" }: { className?: string }) {
  return (
    <div
      className={`flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40 shadow-inner shadow-black/10 ${className}`}
    >
      <div className="shrink-0 border-b border-slate-800/80 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-100">ATG probes</h2>
        <p className="mt-0.5 text-xs text-slate-500">Readings shown for operator awareness.</p>
      </div>
      <ul className="min-h-0 flex-1 space-y-0 overflow-y-auto overscroll-contain px-2 py-2 text-sm text-slate-300">
        {rows.map((r) => (
          <li
            key={r.tank}
            className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 hover:bg-slate-800/50"
          >
            <span className="min-w-0 text-slate-200">
              <span className="font-medium text-slate-100">{r.tank}</span>
              <span className="text-slate-500"> · </span>
              <span>{r.product}</span>
            </span>
            <span className="shrink-0 font-mono text-sm tabular-nums text-sky-100">{r.level}</span>
          </li>
        ))}
      </ul>
      <p className="shrink-0 border-t border-slate-800/80 px-4 py-2 text-xs leading-snug text-slate-500">
        Live ATG integration can be added when the probe protocol is wired to the service.
      </p>
    </div>
  );
}
