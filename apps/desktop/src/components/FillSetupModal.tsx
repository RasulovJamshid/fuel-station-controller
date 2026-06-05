import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import checkIcon     from "@/assets/icons/check.svg";
import dispenserIcon from "@/assets/icons/dispenser.svg";
import dropletIcon   from "@/assets/icons/fuel.svg";
import fullTankIcon  from "@/assets/icons/full-tank.svg";
import moneyIcon     from "@/assets/icons/money.svg";
import playIcon      from "@/assets/icons/play.svg";
import xCircleIcon   from "@/assets/icons/x-circle.svg";
import type { FpState, NozzleSnapshot } from "../types/api";
import type { AuthorizeRequest, FillMode } from "./DispenserCard";

const fmtSum = new Intl.NumberFormat("uz-UZ");

function parseNum(s: string): number {
  const v = parseFloat(s.replace(/\s/g, "").replace(",", "."));
  return isFinite(v) ? v : 0;
}

type Props = {
  open: boolean;
  state: FpState;
  fpNozzles: NozzleSnapshot[];
  mode?: "preauth" | "reactive";
  initialNozzle?: number | null;
  onClose: () => void;
  onConfirm: (req: AuthorizeRequest) => void;
};

export function FillSetupModal({
  open, state, fpNozzles, mode = "reactive", initialNozzle, onClose, onConfirm,
}: Props) {
  const { t } = useTranslation();

  const activeNozzles = useMemo(() => fpNozzles.filter((n) => n.active), [fpNozzles]);
  const multiNozzle   = activeNozzles.length > 1;

  type Step = "nozzle" | "mode" | "value";

  const [selectedNozzle, setSelectedNozzle] = useState<number | null>(null);
  const [fillMode, setFillMode]             = useState<FillMode>("volume");
  const [vol, setVol]                       = useState("10");
  const [amt, setAmt]                       = useState("150000"); // overwritten on open by initPrice×10
  const [step, setStep]                     = useState<Step>(multiNozzle ? "nozzle" : "value");
  const dialogRef   = useRef<HTMLDivElement>(null);
  const volInputRef = useRef<HTMLInputElement>(null);
  const amtInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const init =
      initialNozzle != null && activeNozzles.some((n) => n.index === initialNozzle)
        ? initialNozzle
        : activeNozzles.length === 1 ? (activeNozzles[0]?.index ?? null) : null;
    const initPrice = activeNozzles.find((n) => n.index === init)?.price ?? 0;
    setSelectedNozzle(init);
    setFillMode("volume");
    setVol("10");
    setAmt(initPrice > 0 ? String(initPrice * 10) : "150000");
    setStep(activeNozzles.length > 1 ? "nozzle" : "value");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const root = dialogRef.current;
      if (!root) return;
      if (step === "nozzle") {
        const sel   = root.querySelector<HTMLElement>('[data-nozzle-option][data-selected="true"]');
        const first = root.querySelector<HTMLElement>("[data-nozzle-option]");
        (sel ?? first)?.focus();
      } else if (step === "mode") {
        root.querySelector<HTMLElement>(`button[data-fill-mode='${fillMode}']`)?.focus();
      } else {
        const input = fillMode === "volume" ? volInputRef.current : amtInputRef.current;
        input?.focus();
        input?.select();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [step, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const effectiveNozzle = selectedNozzle ?? (activeNozzles.length === 1 ? activeNozzles[0]!.index : null);
  const selectedSnap    = useMemo(
    () => activeNozzles.find((n) => n.index === effectiveNozzle) ?? null,
    [activeNozzles, effectiveNozzle],
  );
  const price        = selectedSnap?.price ?? 0;
  const productColor = selectedSnap?.product_color ?? "#888";

  const volNum = parseNum(vol);
  const amtNum = parseNum(amt);

  const MAX_VOL = 999;
  const maxAmt  = price > 0 ? Math.floor(price * MAX_VOL) : null;

  const canConfirm =
    effectiveNozzle != null &&
    (fillMode === "full" ||
      (fillMode === "volume" && volNum > 0 && volNum <= MAX_VOL) ||
      (fillMode === "amount" && amtNum > 0 && (maxAmt == null || amtNum <= maxAmt)));

  const handleConfirm = () => {
    if (!canConfirm || effectiveNozzle == null) return;
    let limitValue: number | null = null;
    if (fillMode === "volume") limitValue = volNum;
    else if (fillMode === "amount") limitValue = amtNum;
    onConfirm({ fpId: state.fp_id, nozzleIndex: effectiveNozzle, fillMode, limitValue, priceOverride: null });
  };

  const kolonkaTitle =
    state.label?.trim() ||
    (state.fp_id.match(/\d+/) ? `${state.fp_id.match(/\d+/)![0]}-KOLONKA` : state.fp_id);

  const projectedAmt = fillMode === "volume" && price > 0 && volNum > 0
    ? Math.round(Math.min(volNum, MAX_VOL) * price) : null;
  const projectedVol = fillMode === "amount" && price > 0 && amtNum > 0
    ? Math.min(MAX_VOL, Math.round((amtNum / price) * 10) / 10) : null;
  const atVolLimit = volNum >= MAX_VOL;
  const atAmtLimit = projectedVol != null && projectedVol >= MAX_VOL;

  const isPreauth = mode === "preauth";
  const accentActive = isPreauth
    ? "border-accent-amber/65 bg-accent-amber/12 ring-1 ring-accent-amber/25"
    : "border-accent-emerald/65 bg-accent-emerald/12 ring-1 ring-accent-emerald/25";

  const fillModes: FillMode[] = ["full", "volume", "amount"];

  const getFocusableElements = () => {
    if (!dialogRef.current) return [] as HTMLElement[];
    return Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
  };

  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (step === "value")                  { setStep("mode");   return; }
      if (step === "mode" && multiNozzle)    { setStep("nozzle"); return; }
      onClose();
      return;
    }
    if (e.key === "Tab") {
      const focusables = getFocusableElements();
      if (!focusables.length) return;
      const first  = focusables[0];
      const last   = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first)  { e.preventDefault(); last.focus();  }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      return;
    }
    if (step === "nozzle") {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const ci = activeNozzles.findIndex((n) => n.index === effectiveNozzle);
        const bi = ci >= 0 ? ci : 0;
        const ni = e.key === "ArrowDown"
          ? (bi + 1) % activeNozzles.length
          : (bi - 1 + activeNozzles.length) % activeNozzles.length;
        const nx = activeNozzles[ni]?.index ?? null;
        if (nx == null) return;
        setSelectedNozzle(nx);
        dialogRef.current?.querySelector<HTMLElement>(`button[data-nozzle-option='${nx}']`)?.focus();
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); if (effectiveNozzle != null) setStep("mode"); return; }
    }
    if (step === "mode") {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const idx  = fillModes.indexOf(fillMode);
        if (idx < 0) return;
        const next = e.key === "ArrowRight"
          ? fillModes[(idx + 1) % fillModes.length]
          : fillModes[(idx - 1 + fillModes.length) % fillModes.length];
        setFillMode(next);
        dialogRef.current?.querySelector<HTMLElement>(`button[data-fill-mode='${next}']`)?.focus();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const target   = e.target as HTMLElement;
        const pillMode = (target instanceof HTMLButtonElement && target.dataset.fillMode)
          ? target.dataset.fillMode as FillMode : fillMode;
        if (pillMode !== fillMode) setFillMode(pillMode);
        if (pillMode === "full") { handleConfirm(); return; }
        setStep("value");
        return;
      }
    }
  };

  if (!open) return null;

  function StepBtn({ label, onClick }: { label: "+" | "-"; onClick: () => void }) {
    return (
      <button
        type="button"
        aria-label={label}
        onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); onClick(); }}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
        onKeyDown={(e) => { if (e.key !== "Enter" && e.key !== " ") return; e.preventDefault(); e.stopPropagation(); onClick(); }}
        className="flex h-12 w-12 shrink-0 cursor-pointer select-none items-center justify-center rounded-xl border border-border-primary/70 bg-bg-secondary/95 text-text-primary shadow-sm pointer-events-auto touch-manipulation transition hover:border-border-primary hover:bg-bg-tertiary/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/45"
      >
        <span aria-hidden className="pointer-events-none text-2xl font-black leading-none">{label}</span>
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 backdrop-blur-[2px] sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${kolonkaTitle} — ${isPreauth ? t("authorize.preauthorize") : t("authorize.authorize")}`}
        data-fill-setup-modal="true"
        ref={dialogRef}
        tabIndex={-1}
        className={[
          "flex w-full max-w-lg flex-col overflow-hidden bg-bg-card",
          "border-t-[3px] rounded-t-2xl sm:rounded-2xl sm:border sm:border-t-[3px]",
          "shadow-[0_-10px_34px_rgb(0_0_0/0.32)] sm:shadow-card-hover",
          isPreauth
            ? "border-t-accent-amber sm:border-accent-amber"
            : "border-t-accent-emerald sm:border-accent-emerald",
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        {/* drag handle */}
        <div className="mx-auto mt-2 h-1 w-11 rounded-full bg-border-primary/70 sm:hidden" />

        {/* ── Header ── */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border-primary/60 bg-gradient-to-r from-bg-secondary/55 to-bg-tertiary/35 px-5 py-3.5">
          <img src={dispenserIcon} alt="" aria-hidden className="h-5 w-5 shrink-0 opacity-65" draggable={false} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-black uppercase tracking-wide text-text-primary">{kolonkaTitle}</p>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              {isPreauth ? t("authorize.preauthorize") : t("authorize.authorize")}
            </p>
          </div>

          {/* Single-nozzle product chip — replaces the separate product section */}
          {!multiNozzle && selectedSnap && (
            <div className={`flex shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2 ${accentActive}`}>
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: productColor }} />
              <span className="text-sm font-bold text-text-primary">{selectedSnap.product_name}</span>
              {price > 0 && (
                <div className="text-right">
                  <p className="font-mono text-base font-black tabular-nums text-accent-blue leading-none">
                    {fmtSum.format(price)}
                  </p>
                  <p className="text-[10px] font-semibold text-text-muted">{t("pumpForm.perLiter")}</p>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            tabIndex={-1}
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border-primary/50 bg-bg-secondary text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            aria-label={t("saleSetup.cancel")}
          >
            <img src={xCircleIcon} alt="" aria-hidden className="h-4 w-4" draggable={false} />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-5">

          {/* Multi-nozzle product selection */}
          {multiNozzle && (
            <div className={[
              "rounded-2xl border bg-bg-secondary/25 p-4 transition-all duration-150",
              step === "nozzle" ? "border-accent-blue/45 ring-2 ring-accent-blue/20" : "border-border-primary/55",
            ].join(" ")}>
              <p className="mb-3 text-[10px] font-extrabold uppercase tracking-[0.16em] text-text-muted">
                {t("saleSetup.productSelection")}
              </p>
              <div className="flex flex-col gap-2">
                {activeNozzles.map((n) => {
                  const sel = effectiveNozzle === n.index;
                  return (
                    <button
                      key={n.index}
                      type="button"
                      data-nozzle-option={n.index}
                      data-selected={sel ? "true" : "false"}
                      aria-pressed={sel}
                      onClick={() => { setSelectedNozzle(n.index); setStep("mode"); }}
                      className={[
                        "flex items-center gap-3 rounded-xl border px-4 py-4 text-left shadow-sm transition-all",
                        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/45 focus-visible:ring-offset-1",
                        sel ? accentActive : "border-border-primary/60 bg-bg-secondary/35 hover:border-border-primary hover:bg-bg-secondary/65",
                      ].join(" ")}
                    >
                      <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border-secondary/40"
                        style={{ backgroundColor: n.product_color ?? "#888" }} />
                      <span className="min-w-0 flex-1 truncate text-base font-semibold text-text-primary">
                        {n.product_name}
                      </span>
                      {sel && <img src={checkIcon} alt="" aria-hidden className="h-4 w-4 shrink-0 opacity-70" draggable={false} />}
                      <div className="shrink-0 text-right">
                        <p className="font-mono text-base font-black tabular-nums text-accent-blue leading-none">
                          {n.price > 0 ? fmtSum.format(n.price) : "—"}
                        </p>
                        {n.price > 0 && (
                          <p className="text-[10px] font-semibold text-text-muted">{t("pumpForm.perLiter")}</p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Fill mode tiles ── */}
          <div className={[
            "rounded-2xl border bg-bg-secondary/25 p-3 transition-all duration-150",
            step === "mode" ? "border-accent-blue/45 ring-2 ring-accent-blue/20" : "border-border-primary/55",
          ].join(" ")}>
            <p className="mb-3 text-[10px] font-extrabold uppercase tracking-[0.16em] text-text-muted">
              {t("saleSetup.fillMode")}
            </p>
            <div className="grid grid-cols-3 gap-2">
              {(["full", "volume", "amount"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  data-fill-mode={m}
                  aria-pressed={fillMode === m}
                  data-active={fillMode === m}
                  onClick={() => { setFillMode(m); setStep(m === "full" ? "mode" : "value"); }}
                  className="pump-mode-pill flex-col gap-1.5 px-2 py-3.5"
                >
                  <img
                    src={m === "full" ? fullTankIcon : m === "volume" ? dropletIcon : moneyIcon}
                    alt="" aria-hidden
                    className="h-5 w-5 shrink-0"
                    draggable={false}
                  />
                  <span className="text-sm font-bold">
                    {t(m === "full" ? "pumpForm.fillModeFull" : m === "volume" ? "pumpForm.fillModeVol" : "pumpForm.fillModeAmt")}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Volume input */}
          {fillMode === "volume" && (
            <div className={[
              "flex flex-col gap-3 rounded-2xl border bg-bg-secondary/20 p-4 transition-all duration-150",
              step === "value" ? "border-accent-blue/45 ring-2 ring-accent-blue/20" : "border-border-primary/55",
            ].join(" ")}>
              <div className="relative isolate flex items-center gap-3">
                <StepBtn label="-" onClick={() => setVol((v) => String(Math.max(1, parseNum(v) - 1)))} />
                <div className="flex flex-1 items-center gap-2 rounded-xl border border-border-primary/60 bg-bg-input px-4 py-3.5 shadow-sm transition focus-within:border-accent-blue/55 focus-within:ring-2 focus-within:ring-accent-blue/20">
                  <input
                    ref={volInputRef}
                    type="text"
                    inputMode="decimal"
                    value={vol}
                    onFocus={() => setStep("value")}
                    onChange={(e) => setVol(e.target.value)}
                    onBlur={() => setVol((v) => String(Math.min(MAX_VOL, Math.max(1, parseNum(v) || 1))))}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp")        { e.preventDefault(); setVol((v) => String(Math.min(MAX_VOL, parseNum(v) + 1))); }
                      else if (e.key === "ArrowDown") { e.preventDefault(); setVol((v) => String(Math.max(1, parseNum(v) - 1))); }
                      else if (e.key === "Enter")     { e.preventDefault(); handleConfirm(); }
                    }}
                    className="w-full bg-transparent text-center font-mono text-3xl font-black tabular-nums text-text-primary outline-none"
                  />
                  <span className="shrink-0 text-base font-bold text-text-muted">L</span>
                </div>
                <StepBtn label="+" onClick={() => setVol((v) => String(Math.min(MAX_VOL, parseNum(v) + 1)))} />
              </div>
              {projectedAmt != null && (
                <p className={`rounded-xl border py-2.5 text-center font-mono text-base font-semibold tabular-nums ${atVolLimit ? "border-accent-amber/40 bg-accent-amber/10 text-accent-amber" : "border-accent-blue/30 bg-accent-blue/10 text-accent-blue"}`}>
                  {atVolLimit ? "⚠ MAX " : "≈ "}{fmtSum.format(projectedAmt)} {t("pumpForm.amountUnit")}
                </p>
              )}
            </div>
          )}

          {/* Amount input */}
          {fillMode === "amount" && (
            <div className={[
              "flex flex-col gap-3 rounded-2xl border bg-bg-secondary/20 p-4 transition-all duration-150",
              step === "value" ? "border-accent-blue/45 ring-2 ring-accent-blue/20" : "border-border-primary/55",
            ].join(" ")}>
              <div className="relative isolate flex items-center gap-3">
                <StepBtn label="-" onClick={() => setAmt((v) => String(Math.max(10000, parseNum(v) - 10000)))} />
                <div className="flex flex-1 items-center gap-2 rounded-xl border border-border-primary/60 bg-bg-input px-4 py-3.5 shadow-sm transition focus-within:border-accent-blue/55 focus-within:ring-2 focus-within:ring-accent-blue/20">
                  <input
                    ref={amtInputRef}
                    type="text"
                    inputMode="numeric"
                    value={amt}
                    onFocus={() => setStep("value")}
                    onChange={(e) => setAmt(e.target.value)}
                    onBlur={() => setAmt((v) => {
                      const n = Math.max(10000, parseNum(v) || 10000);
                      return String(maxAmt != null ? Math.min(maxAmt, n) : n);
                    })}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp")        { e.preventDefault(); setAmt((v) => String(Math.min(maxAmt ?? Infinity, parseNum(v) + 10000))); }
                      else if (e.key === "ArrowDown") { e.preventDefault(); setAmt((v) => String(Math.max(10000, parseNum(v) - 10000))); }
                      else if (e.key === "Enter")     { e.preventDefault(); handleConfirm(); }
                    }}
                    className="w-full bg-transparent text-center font-mono text-3xl font-black tabular-nums text-text-primary outline-none"
                  />
                  <span className="shrink-0 text-base font-bold text-text-muted">{t("pumpForm.amountUnit")}</span>
                </div>
                <StepBtn label="+" onClick={() => setAmt((v) => String(Math.min(maxAmt ?? Infinity, parseNum(v) + 10000)))} />
              </div>
              {projectedVol != null && (
                <p className={`rounded-xl border py-2.5 text-center font-mono text-base font-semibold tabular-nums ${atAmtLimit ? "border-accent-amber/40 bg-accent-amber/10 text-accent-amber" : "border-accent-emerald/30 bg-accent-emerald/10 text-text-secondary"}`}>
                  {atAmtLimit ? "⚠ MAX " : "≈ "}{projectedVol} L
                </p>
              )}
            </div>
          )}

          {/* Full-tank description */}
          {fillMode === "full" && (
            <p className="rounded-xl border border-border-primary/50 bg-bg-input/55 px-4 py-4 text-center text-sm leading-relaxed text-text-muted">
              {t("saleSetup.fullTankDesc")}
            </p>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex shrink-0 items-center gap-3 border-t border-border-primary/60 bg-bg-secondary/35 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-xl px-4 py-3 text-sm font-semibold text-text-tertiary transition-colors hover:bg-bg-secondary hover:text-text-secondary"
          >
            <img src={xCircleIcon} alt="" aria-hidden className="h-4 w-4 shrink-0" draggable={false} />
            {t("saleSetup.cancel")}
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={handleConfirm}
            className={[
              "flex flex-1 items-center justify-center gap-2 rounded-xl py-4 text-base font-black uppercase tracking-wide",
              "shadow-md transition disabled:cursor-not-allowed disabled:opacity-50",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
              isPreauth
                ? "bg-accent-amber text-text-inverse hover:bg-accent-amber-light focus-visible:ring-accent-amber/60"
                : "btn-start-glow pump-start-button text-white focus-visible:ring-accent-emerald/60",
            ].join(" ")}
          >
            <img src={playIcon} alt="" aria-hidden className="h-5 w-5 shrink-0" draggable={false} />
            {isPreauth ? t("authorize.preauthorize") : t("authorize.authorize")}
          </button>
        </div>
      </div>
    </div>
  );
}
