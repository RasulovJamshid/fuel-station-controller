import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { FpState, Shift, SiteSnapshot, WsEvent } from "../types/api";
import { useAppStore } from "../store";

/** Shared bootstrap helper — fetches config+status and retries until success. */
async function bootstrapFromService(
  setSiteSnapshot: (s: SiteSnapshot | null) => void,
  setStates: (rows: FpState[]) => void,
  setCurrentShift: (s: Shift | null) => void,
  setSite: (name: string) => void,
  setConnection: (label: string) => void,
  cancelled: () => boolean,
  attempt = 0,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const [cfg, rows, health] = await Promise.all([
      invoke<SiteSnapshot>("get_site_config"),
      invoke<FpState[]>("get_all_status"),
      invoke<{ site?: string }>("get_health").catch(() => null),
    ]);
    if (cancelled()) return;
    setSiteSnapshot(cfg);
    setStates(rows);
    if (health?.site) setSite(health.site);
    setConnection("localhost");
    const mode = cfg.shift_mode ?? "manual";
    if (mode !== "disabled") {
      try {
        const active = await invoke<Shift | null>("get_current_shift");
        if (!cancelled()) setCurrentShift(active);
      } catch (e) {
        console.error("get_current_shift failed", e);
      }
    }
  } catch (e) {
    if (cancelled()) return;
    // Service not ready yet — retry with backoff (max 3 s)
    const delay = Math.min(500 * 2 ** attempt, 3000);
    console.warn(`bootstrap failed (attempt ${attempt + 1}), retrying in ${delay}ms…`, e);
    await new Promise((r) => setTimeout(r, delay));
    if (!cancelled()) await bootstrapFromService(
      setSiteSnapshot, setStates, setCurrentShift, setSite, setConnection, cancelled, attempt + 1,
    );
  }
}

export function useServiceEvents() {
  const applyEvent = useAppStore((s) => s.applyWsEvent);
  const setConnected = useAppStore((s) => s.setWsConnected);
  const setSiteSnapshot = useAppStore((s) => s.setSiteSnapshot);
  const setStates = useAppStore((s) => s.setStates);
  const setCurrentShift = useAppStore((s) => s.setCurrentShift);
  const setSite = useAppStore((s) => s.setSite);
  const setConnection = useAppStore((s) => s.setConnection);
  const resetServiceState = useAppStore((s) => s.resetServiceState);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      unlisten = await listen<string>("dispenser_event", (ev) => {
        try {
          const parsed = JSON.parse(ev.payload) as WsEvent;
          setConnected(true);
          if (parsed.event === "service.connected") {
            // Wipe holdDoneUntil and other transient display guards accumulated
            // during the previous session so the fresh snapshot from
            // bootstrapFromService is applied without the stale DONE-hold or
            // nozzle-removed banners blocking the update.
            resetServiceState();
            void bootstrapFromService(
              setSiteSnapshot, setStates, setCurrentShift, setSite, setConnection,
              () => cancelled,
            );
            return;
          }
          applyEvent(parsed);
        } catch (e) {
          console.error("dispenser_event parse failed", e, ev.payload?.slice?.(0, 200));
        }
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyEvent, setConnected, setSiteSnapshot, setStates, setCurrentShift, setSite, setConnection, resetServiceState]);
}

/** Single bootstrap on mount with retry. */
export function useBootstrapStatus() {
  const setStates = useAppStore((s) => s.setStates);
  const setSiteSnapshot = useAppStore((s) => s.setSiteSnapshot);
  const setCurrentShift = useAppStore((s) => s.setCurrentShift);
  const setSite = useAppStore((s) => s.setSite);
  const setConnection = useAppStore((s) => s.setConnection);
  const siteSnapshot = useAppStore((s) => s.siteSnapshot);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let cancelled = false;
    void bootstrapFromService(
      setSiteSnapshot, setStates, setCurrentShift, setSite, setConnection,
      () => cancelled,
    );
    return () => { cancelled = true; };
  }, [setStates, setSiteSnapshot, setCurrentShift, setSite, setConnection]);

  useEffect(() => {
    if (siteSnapshot) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      void bootstrapFromService(
        setSiteSnapshot, setStates, setCurrentShift, setSite, setConnection,
        () => cancelled,
      );
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [siteSnapshot, setStates, setSiteSnapshot, setCurrentShift, setSite, setConnection]);
}

/** No-op — bootstrap is now handled by useBootstrapStatus. */
export function useBootstrapSiteConfig() {}

export function useProbeSim() {
  const setSimOnline = useAppStore((s) => s.setSimOnline);
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const ok = await invoke<boolean>("probe_sim");
        if (!cancelled) setSimOnline(Boolean(ok));
      } catch {
        if (!cancelled) setSimOnline(false);
      }
    };
    void probe();
    const id = setInterval(() => void probe(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [setSimOnline]);
}

export function useBootstrapHealth() {}

/** Poll dispenser-service status so UI tracks sim actions even if WS events lag. */
export function useStatusPoll(intervalMs = 400) {
  const setStates = useAppStore((s) => s.setStates);
  const siteSnapshot = useAppStore((s) => s.siteSnapshot);

  useEffect(() => {
    if (!siteSnapshot) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const rows = await invoke<FpState[]>("get_all_status");
        if (!cancelled) setStates(rows);
      } catch {
        /* service may be restarting */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [siteSnapshot, setStates, intervalMs]);
}
