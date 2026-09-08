import { useTranslation } from "react-i18next";

const fmtL = new Intl.NumberFormat("uz-UZ");
const gaugeTicks = [100, 75, 50, 25, 0];

type Tone = "emerald" | "amber" | "blue";

const toneMap: Record<Tone, string> = {
  emerald: "bg-accent-emerald/70",
  amber: "bg-accent-amber/70",
  blue: "bg-accent-blue/70",
};

function levelState(pct: number): "critical" | "low" | "ok" {
  if (pct < 10) return "critical";
  if (pct < 25) return "low";
  return "ok";
}

/** Returns a human-readable "X min ago" / "X h ago" string, or null if recent (< 2 min). */
function staleLabel(updatedAtMs: number | undefined): string | null {
  if (updatedAtMs == null) return null;
  const ageMs = Date.now() - updatedAtMs;
  const ageSec = Math.floor(ageMs / 1000);
  if (ageSec < 120) return null;          // fresh — no label
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)} min ago`;
  return `${Math.floor(ageSec / 3600)} h ago`;
}

export function TankGauge(props: {
  label: string;
  levelPct: number;
  subtitle?: string;
  currentL?: number;
  capacityL?: number;
  temperatureC?: number;
  waterL?: number;
  updatedAtMs?: number;
  tone?: Tone;
  className?: string;
  probe?: string;
}) {
  const { t } = useTranslation();
  const pct    = Math.max(0, Math.min(100, props.levelPct));
  const tone   = props.tone ?? "blue";
  const state  = levelState(pct);
  const fill = state === "critical"
    ? "bg-accent-red/70"
    : state === "low" ? "bg-accent-amber/70" : toneMap[tone];
  const capacity = props.capacityL ?? null;
  const current  = props.currentL ?? null;
  const free     = capacity != null && current != null ? Math.max(capacity - current, 0) : null;

  const stale   = staleLabel(props.updatedAtMs);
  const hasLive = props.updatedAtMs != null;

  const statusBadge =
    state === "critical"
      ? "border-accent-red/30 bg-accent-red/10 text-accent-red"
      : state === "low"
        ? "border-accent-amber/30 bg-accent-amber/10 text-accent-amber"
        : null;

  const statusLabel =
    state === "critical" ? t("tankGauge.critical") : state === "low" ? t("tankGauge.low") : null;

  const tempStr = props.temperatureC != null
    ? `${props.temperatureC.toFixed(1)}°C`
    : "—";

  const waterStr = props.waterL != null
    ? `${fmtL.format(Math.round(props.waterL))} L`
    : "—";

  return (
    <article className={`flex min-w-0 flex-col overflow-hidden rounded-lg border border-border-primary/60 bg-bg-card ${props.className ?? ""}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border-primary/50 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-text-tertiary">
            {t("tankGauge.tank")} <span aria-hidden>·</span> {props.probe ?? "ATG"}
          </p>
          <h3 className="mt-1 break-words text-lg font-semibold leading-tight text-text-primary">{props.label}</h3>
          {props.subtitle && props.subtitle !== props.label ? (
            <p className="mt-1 break-words text-xs text-text-secondary">{props.subtitle}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {hasLive && !stale && (
            <span className="flex items-center gap-1.5 text-xs text-text-secondary">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-emerald" aria-hidden />
              {t("tankGauge.live")}
            </span>
          )}
          {stale && <span className="text-xs text-accent-amber">{stale}</span>}
          {statusBadge && (
            <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${statusBadge}`}>
              {statusLabel}
            </span>
          )}
        </div>
      </header>

      <div className="flex flex-1 gap-4 p-4">
        <div className="shrink-0">
          <div className="flex items-center gap-2">
            <div className="relative h-40 w-6 text-right text-[10px] tabular-nums text-text-tertiary" aria-hidden>
              {gaugeTicks.map((tick) => (
                <span key={tick} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - tick}%` }}>
                  {tick}
                </span>
              ))}
            </div>
            <div
              role="meter"
              aria-label={`${props.label}: ${t("tankGauge.level")}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-valuetext={`${pct}%${statusLabel ? `, ${statusLabel}` : ""}`}
              className="relative h-40 w-12 overflow-hidden rounded border border-border-primary/60 bg-bg-primary"
            >
              <div
                className={`absolute inset-x-0 bottom-0 transition-[height] duration-300 motion-reduce:transition-none ${fill}`}
                style={{ height: `${pct}%` }}
              />
              <div className="pointer-events-none absolute inset-0" aria-hidden>
                {gaugeTicks.slice(1, -1).map((tick) => (
                  <div key={tick} className="absolute inset-x-0 border-t border-border-primary/50" style={{ top: `${100 - tick}%` }} />
                ))}
              </div>
            </div>
          </div>
          <p className="mt-3 text-center text-lg font-semibold tabular-nums text-text-primary">
            {pct}<span className="ml-0.5 text-xs font-normal text-text-secondary">%</span>
          </p>
          <p className="text-center text-xs text-text-tertiary">{t("tankGauge.level")}</p>
        </div>

        <dl className="flex min-w-0 flex-1 flex-col gap-4">
          <div>
            <dt className="text-xs text-text-secondary">{t("tankGauge.currentStock")}</dt>
            <dd className="mt-1 break-words font-mono text-2xl font-semibold tabular-nums leading-tight text-text-primary">
              {current != null ? fmtL.format(current) : "—"} <span className="text-xs font-normal text-text-secondary">L</span>
            </dd>
          </div>
          <div className="border-t border-border-primary/40 pt-3">
            <dt className="text-xs text-text-secondary">{t("tankGauge.capacity")}</dt>
            <dd className="mt-1 break-words font-mono text-sm font-medium tabular-nums text-text-primary">
              {capacity != null ? fmtL.format(capacity) : "—"} <span className="text-xs font-normal text-text-secondary">L</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-text-secondary">{t("tankGauge.available")}</dt>
            <dd className={`mt-1 break-words font-mono text-sm font-medium tabular-nums ${free != null && free < (capacity ?? 0) * 0.25 ? "text-accent-amber" : "text-text-primary"}`}>
              {free != null ? fmtL.format(free) : "—"} <span className="text-xs font-normal text-text-secondary">L</span>
            </dd>
          </div>
        </dl>
      </div>

      <footer className="border-t border-border-primary/50 px-4 py-3">
        <dl className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <dt className="text-xs text-text-secondary">{t("tankGauge.temp")}</dt>
            <dd className={`mt-1 font-mono text-sm font-medium tabular-nums ${props.temperatureC != null ? "text-text-primary" : "text-text-tertiary"}`}>
              {tempStr}
            </dd>
          </div>
          <div className="min-w-0 text-right">
            <dt className="text-xs text-text-secondary">{t("tankGauge.water")}</dt>
            <dd className={`mt-1 break-words font-mono text-sm font-medium tabular-nums ${props.waterL != null && props.waterL > 0 ? "text-accent-amber" : "text-text-primary"}`}>
              {waterStr}
            </dd>
          </div>
        </dl>
        {!hasLive && (
          <p className="mt-3 border-t border-border-primary/40 pt-3 text-xs text-text-tertiary">
            {t("tankGauge.atgUpdate")}
          </p>
        )}
      </footer>
    </article>
  );
}
