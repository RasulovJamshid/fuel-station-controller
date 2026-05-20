import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FpSnapshot, SimDispenserInfo, SiteLayout } from "./types";
import { SCENARIOS } from "./types";

function statusClass(status: string): string {
  const s = status.toUpperCase();
  if (s.includes("DELIVER")) return "bg-emerald-500/20 text-emerald-300";
  if (s.includes("AUTH") || s.includes("PRE")) return "bg-amber-500/20 text-amber-300";
  if (s.includes("OFFLINE") || s.includes("DOWN")) return "bg-slate-500/30 text-slate-400";
  if (s.includes("ERROR") || s.includes("STOP")) return "bg-rose-500/20 text-rose-300";
  return "bg-sky-500/15 text-sky-300";
}

function LaneCard({
  fp,
  layout,
  busy,
  onAction,
}: {
  fp: SimDispenserInfo;
  layout?: FpSnapshot;
  busy: string | null;
  onAction: (fn: () => Promise<void>, key: string) => void;
}) {
  const nozzles = layout?.nozzles?.filter((n) => n.active) ?? [];
  const isBusy = (k: string) => busy?.startsWith(`${fp.fp_id}:${k}`) ?? false;

  return (
    <article className="rounded-xl border border-slate-700/80 bg-slate-900/80 p-4 shadow-lg">
      <header className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">{fp.label || fp.fp_id}</h2>
          <p className="text-xs text-slate-500">
            {fp.fp_id} · addr {fp.addr}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusClass(fp.status)}`}>
          {fp.status}
        </span>
      </header>

      <dl className="mb-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-slate-500">Volume</dt>
          <dd className="font-mono text-slate-200">{fp.volume.toFixed(2)} L</dd>
        </div>
        <div>
          <dt className="text-slate-500">Amount</dt>
          <dd className="font-mono text-slate-200">{(fp.amount / 100).toFixed(2)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Respond</dt>
          <dd className={fp.respond ? "text-emerald-400" : "text-rose-400"}>
            {fp.respond ? "yes" : "no"}
          </dd>
        </div>
      </dl>

      <div className="mb-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={!!busy}
          className="rounded-md bg-slate-700 px-2.5 py-1 text-xs hover:bg-slate-600 disabled:opacity-40"
          onClick={() => onAction(() => invoke("sim_nozzle_down", { fpId: fp.fp_id }), "down")}
        >
          {isBusy("down") ? "…" : "Nozzle down"}
        </button>
        <button
          type="button"
          disabled={!!busy}
          className="rounded-md bg-slate-700 px-2.5 py-1 text-xs hover:bg-slate-600 disabled:opacity-40"
          onClick={() => onAction(() => invoke("sim_go_offline", { fpId: fp.fp_id }), "offline")}
        >
          Offline
        </button>
        <button
          type="button"
          disabled={!!busy}
          className="rounded-md bg-slate-700 px-2.5 py-1 text-xs hover:bg-slate-600 disabled:opacity-40"
          onClick={() =>
            onAction(() => invoke("sim_go_online", { fpId: fp.fp_id, flush: false }), "online")
          }
        >
          Online
        </button>
        <button
          type="button"
          disabled={!!busy}
          className="rounded-md bg-slate-700 px-2.5 py-1 text-xs hover:bg-slate-600 disabled:opacity-40"
          onClick={() =>
            onAction(() => invoke("sim_go_online", { fpId: fp.fp_id, flush: true }), "flush")
          }
        >
          Online + flush
        </button>
      </div>

      {nozzles.length > 0 ? (
        <div className="space-y-1.5 border-t border-slate-800 pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Lift nozzle</p>
          {nozzles.map((n) => (
            <div key={n.index} className="flex flex-wrap gap-1">
              <button
                type="button"
                disabled={!!busy}
                className="flex-1 rounded-md px-2 py-1.5 text-xs font-medium text-slate-900 disabled:opacity-40"
                style={{ backgroundColor: n.product_color || "#64748b" }}
                onClick={() =>
                  onAction(
                    () =>
                      invoke("sim_nozzle_up", {
                        fpId: fp.fp_id,
                        nozzle: n.index,
                        product: n.product_id,
                        productName: n.product_name,
                      }),
                    `up-${n.index}`,
                  )
                }
              >
                {isBusy(`up-${n.index}`) ? "…" : `↑ ${n.product_name}`}
              </button>
              <button
                type="button"
                disabled={!!busy}
                className="rounded-md border border-amber-600/50 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-200 hover:bg-amber-900/50 disabled:opacity-40"
                title="Set expected grade (pre-auth on operator app first)"
                onClick={() =>
                  onAction(
                    () =>
                      invoke("sim_prepare_preauth", {
                        fpId: fp.fp_id,
                        nozzle: n.index,
                        product: n.product_id,
                        productName: n.product_name,
                      }),
                    `pre-${n.index}`,
                  )
                }
              >
                Pre
              </button>
            </div>
          ))}
        </div>
      ) : (
        <button
          type="button"
          disabled={!!busy}
          className="mt-2 w-full rounded-md bg-sky-700/80 py-1.5 text-xs hover:bg-sky-600 disabled:opacity-40"
          onClick={() =>
            onAction(() => invoke("sim_nozzle_up", { fpId: fp.fp_id }), "up-default")
          }
        >
          Nozzle up (default)
        </button>
      )}
    </article>
  );
}

export default function App() {
  const [simOk, setSimOk] = useState<boolean | null>(null);
  const [state, setState] = useState<SimDispenserInfo[]>([]);
  const [layout, setLayout] = useState<SiteLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scenarioMsg, setScenarioMsg] = useState<string | null>(null);
  const [pollMs, setPollMs] = useState(800);

  const layoutByFp = useMemo(() => {
    const m = new Map<string, FpSnapshot>();
    for (const p of layout?.positions ?? []) {
      m.set(p.fp_id, p);
    }
    return m;
  }, [layout]);

  const refresh = useCallback(async () => {
    try {
      const ok = await invoke<boolean>("probe_sim");
      setSimOk(ok);
      if (!ok) {
        setState([]);
        return;
      }
      const rows = await invoke<SimDispenserInfo[]>("get_sim_state");
      setState(rows);
      setError(null);
    } catch (e) {
      setSimOk(false);
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  useEffect(() => {
    void invoke<SiteLayout | null>("get_site_layout").then(setLayout).catch(() => setLayout(null));
    const t = setInterval(() => {
      void invoke<SiteLayout | null>("get_site_layout").then(setLayout).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const runAction = useCallback(
    async (fn: () => Promise<void>, key: string) => {
      setBusy(key);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const runGlobal = useCallback(
    async (cmd: string) => {
      setBusy(cmd);
      setError(null);
      try {
        await invoke(cmd);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const runScenario = useCallback(
    async (name: string) => {
      setBusy(`scenario:${name}`);
      setScenarioMsg(null);
      setError(null);
      try {
        const msg = await invoke<string>("sim_run_scenario", { name });
        setScenarioMsg(msg);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Wayne Sim Control</h1>
            <p className="text-sm text-slate-500">
              {layout?.site_name ?? "Protocol simulator"} · poll {pollMs}ms
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                simOk === true
                  ? "bg-emerald-500/20 text-emerald-300"
                  : simOk === false
                    ? "bg-rose-500/20 text-rose-300"
                    : "bg-slate-700 text-slate-400"
              }`}
            >
              Sim API {simOk === true ? "connected" : simOk === false ? "offline" : "…"}
            </span>
            <label className="flex items-center gap-2 text-xs text-slate-500">
              Poll
              <select
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200"
                value={pollMs}
                onChange={(e) => setPollMs(Number(e.target.value))}
              >
                <option value={400}>400ms</option>
                <option value={800}>800ms</option>
                <option value={1500}>1.5s</option>
              </select>
            </label>
            <button
              type="button"
              className="rounded-md bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700"
              onClick={() => void refresh()}
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-4">
        <section className="mb-4 flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
          <button
            type="button"
            disabled={!!busy || !simOk}
            className="rounded-md bg-rose-800/80 px-4 py-2 text-sm font-medium hover:bg-rose-700 disabled:opacity-40"
            onClick={() => void runGlobal("sim_estop_all")}
          >
            E-stop all
          </button>
          <button
            type="button"
            disabled={!!busy || !simOk}
            className="rounded-md bg-slate-700 px-4 py-2 text-sm font-medium hover:bg-slate-600 disabled:opacity-40"
            onClick={() => void runGlobal("sim_reset_all")}
          >
            Reset all
          </button>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={!!busy || !simOk}
                className="rounded-md border border-violet-700/50 bg-violet-950/40 px-2.5 py-1.5 text-xs text-violet-200 hover:bg-violet-900/40 disabled:opacity-40"
                onClick={() => void runScenario(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </section>

        {error && (
          <p className="mb-3 rounded-lg border border-rose-800/50 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">
            {error}
          </p>
        )}
        {scenarioMsg && (
          <p className="mb-3 rounded-lg border border-violet-800/50 bg-violet-950/30 px-3 py-2 text-sm text-violet-200">
            {scenarioMsg}
          </p>
        )}

        {!simOk && simOk !== null && (
          <p className="mb-4 text-sm text-slate-500">
            Start the stack with <code className="text-sky-400">./scripts/azs.sh dev-sim</code> (sim on port
            3002).
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {state.map((fp) => (
            <LaneCard
              key={fp.fp_id}
              fp={fp}
              layout={layoutByFp.get(fp.fp_id)}
              busy={busy}
              onAction={(fn, key) => void runAction(fn, `${fp.fp_id}:${key}`)}
            />
          ))}
        </div>

        {state.length === 0 && simOk && (
          <p className="text-center text-sm text-slate-500">No dispensers in sim state.</p>
        )}
      </main>
    </div>
  );
}
