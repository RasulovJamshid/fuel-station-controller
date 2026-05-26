const fmtL = new Intl.NumberFormat("uz-UZ");
const gaugeTicks = [100, 75, 50, 25, 0];

type Tone = "emerald" | "amber" | "blue";

const toneMap: Record<Tone, {
  badge:   string;
  fill:    string;
  surface: string;
  bar:     string;
  chip:    string;
  glow:    string;
}> = {
  emerald: {
    badge:   "bg-accent-emerald/15 text-accent-emerald ring-1 ring-accent-emerald/30",
    fill:    "bg-gradient-to-t from-accent-emerald-dark/80 via-accent-emerald/60 to-accent-emerald-light/40",
    surface: "bg-accent-emerald/80",
    bar:     "bg-accent-emerald",
    chip:    "bg-accent-emerald/15 text-accent-emerald",
    glow:    "from-accent-emerald/20 via-accent-emerald/5",
  },
  amber: {
    badge:   "bg-accent-amber/15 text-accent-amber ring-1 ring-accent-amber/30",
    fill:    "bg-gradient-to-t from-accent-amber-dark/80 via-accent-amber/60 to-accent-amber-light/40",
    surface: "bg-accent-amber/80",
    bar:     "bg-accent-amber",
    chip:    "bg-accent-amber/15 text-accent-amber",
    glow:    "from-accent-amber/25 via-accent-amber/8",
  },
  blue: {
    badge:   "bg-accent-blue/15 text-accent-blue ring-1 ring-accent-blue/30",
    fill:    "bg-gradient-to-t from-accent-blue/90 via-accent-blue/65 to-accent-blue/40",
    surface: "bg-accent-blue/80",
    bar:     "bg-accent-blue",
    chip:    "bg-accent-blue/15 text-accent-blue",
    glow:    "from-accent-blue/25 via-accent-blue/8",
  },
};

function levelState(pct: number): "critical" | "low" | "ok" {
  if (pct < 10) return "critical";
  if (pct < 25) return "low";
  return "ok";
}

export function TankGauge(props: {
  label: string;
  levelPct: number;
  subtitle?: string;
  currentL?: number;
  capacityL?: number;
  tone?: Tone;
  className?: string;
  compact?: boolean;
  vertical?: boolean;
  probe?: string;
}) {
  const pct    = Math.max(0, Math.min(100, props.levelPct));
  const tone   = props.tone ?? "blue";
  const styles = toneMap[tone];
  const state  = levelState(pct);
  const capacity = props.capacityL ?? null;
  const current  = props.currentL ?? null;
  const free     = capacity != null && current != null ? Math.max(capacity - current, 0) : null;

  const statusBadge =
    state === "critical"
      ? "bg-accent-red/15 text-accent-red ring-1 ring-accent-red/30"
      : state === "low"
        ? "bg-accent-amber/15 text-accent-amber ring-1 ring-accent-amber/30"
        : null;

  const statusLabel =
    state === "critical" ? "Kritik" : state === "low" ? "Kam" : null;

  return (
    <article className={`relative flex flex-col overflow-hidden rounded-[32px] border border-border-primary/60 bg-gradient-to-br from-bg-card/95 via-bg-card/75 to-bg-primary/60 shadow-[0_25px_45px_rgba(5,10,20,0.45)] ${props.className ?? ""}`}>
      <div className={`pointer-events-none absolute inset-x-6 top-4 h-24 rounded-full bg-gradient-to-b ${styles.glow} to-transparent blur-2xl`} aria-hidden />
      <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.35em] text-text-tertiary">
            <span>Tank</span>
            <span className="h-1 w-1 rounded-full bg-text-tertiary/50" aria-hidden />
            <span>{props.probe ?? "ATG"}</span>
          </div>
          <p className="text-xl font-black text-text-primary leading-tight">{props.label}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] font-semibold">
            <span className={`rounded-full px-2.5 py-0.5 ${styles.chip}`}>{props.label}</span>
            {props.subtitle ? <span className="text-text-muted/80">{props.subtitle}</span> : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          {statusBadge && (
            <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${statusBadge}`}>
              {statusLabel}
            </span>
          )}
          <span className={`flex items-end gap-1 rounded-full px-3 py-1 text-text-primary shadow-inner ${styles.badge}`}>
            <span className="text-2xl font-black leading-none">{pct}</span>
            <span className="text-xs font-semibold">%</span>
          </span>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-4 pb-4">
        <div className="flex gap-4">
          <div className="flex w-7 shrink-0 flex-col items-end justify-between pr-0.5 text-[9px] font-semibold tabular-nums text-text-muted/80">
            {gaugeTicks.map((tick) => (
              <span key={tick}>{tick}</span>
            ))}
          </div>

          <div className="relative flex w-20 flex-col items-center">
            <div className="relative h-40 w-full overflow-hidden rounded-[1.3rem] border border-border-primary/40 bg-gradient-to-b from-bg-primary/80 via-bg-secondary/40 to-bg-tertiary/40 shadow-[inset_0_8px_16px_rgba(0,0,0,0.25)]">
              <div className="pointer-events-none absolute inset-0 flex flex-col justify-between py-3">
                {gaugeTicks.map((tick) => (
                  <div key={tick} className="w-full border-b border-dashed border-border-primary/25" />
                ))}
              </div>
              <div
                className={`absolute bottom-0 left-0 right-0 z-10 rounded-t-[4px] transition-all duration-700 ease-out ${styles.fill}`}
                style={{ height: `${pct}%`, minHeight: "0.75rem" }}
              >
                <div className={`absolute top-0 h-[4px] w-full ${styles.surface}`} />
                <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent" aria-hidden />
              </div>
            </div>
            <span className="mt-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-text-secondary">Level</span>
          </div>

          <div className="flex flex-1 flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 rounded-2xl border border-border-primary/40 bg-bg-primary/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-text-tertiary">
              <div>
                <p>Capacity</p>
                <p className="text-base font-black text-text-primary tracking-tight">
                  {capacity != null ? fmtL.format(capacity) : "—"} <span className="text-[11px] font-semibold text-text-secondary">L</span>
                </p>
              </div>
              <div>
                <p>Available</p>
                <p className={`text-base font-black tracking-tight ${free != null && free < (capacity ?? 0) * 0.25 ? "text-accent-amber" : "text-text-primary"}`}>
                  {free != null ? fmtL.format(free) : "—"} <span className="text-[11px] font-semibold text-text-secondary">L</span>
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-dashed border-border-primary/50 bg-bg-secondary/30 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-text-tertiary">Current stock</p>
              <p className="font-mono text-xl font-black tabular-nums text-text-primary">
                {current != null ? fmtL.format(current) : "—"} <span className="text-xs font-semibold text-text-secondary">L</span>
              </p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary/70">
                <div className={`h-full rounded-full transition-all duration-700 ${styles.bar}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-text-muted">
                <div>
                  <p>Temp</p>
                  <p className="text-sm font-black text-text-primary">{props.subtitle?.match(/(\d+°C)/)?.[0] ?? "24°C"}</p>
                </div>
                <div className="text-right">
                  <p>Probe</p>
                  <p className="text-sm font-black text-text-primary">{props.probe ?? "ATG"}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {(current == null || capacity == null) && (
          <div className="rounded-2xl border border-border-primary/40 bg-bg-primary/40 px-3 py-2 text-[11px] text-center text-text-muted">
            Zaxira ma'lumotlari ATG orqali yangilanadi.
          </div>
        )}
      </div>
    </article>
  );
}
