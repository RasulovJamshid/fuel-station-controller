/**
 * FillSetupModal — native-styled product + fill-mode selection dialog.
 *
 * Drop-in replacement for AuthorizeModal + SaleSetupPanel that uses the
 * app's CSS-variable token system throughout (bg-bg-*, text-text-*,
 * border-border-*) so it renders correctly in both light and dark mode
 * without any `!important` overrides.
 *
 * On small viewports it slides up from the bottom (sheet style).
 * On larger viewports it centres as a traditional dialog.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import checkIcon    from "@/assets/icons/check.svg";
import dispenserIcon from "@/assets/icons/dispenser.svg";
import dropletIcon  from "@/assets/icons/fuel.svg";
import fullTankIcon from "@/assets/icons/full-tank.svg";
import minusIcon    from "@/assets/icons/minus.svg";
import moneyIcon    from "@/assets/icons/money.svg";
import playIcon     from "@/assets/icons/play.svg";
import plusIcon     from "@/assets/icons/plus.svg";
import xCircleIcon  from "@/assets/icons/x-circle.svg";
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

/* ─────────────────────────────────────────────────────────────────────────── */

export function FillSetupModal({
  open,
  state,
  fpNozzles,
  mode = "reactive",
  initialNozzle,
  onClose,
  onConfirm,
}: Props) {
  const { t } = useTranslation();

  const activeNozzles = useMemo(() => fpNozzles.filter((n) => n.active), [fpNozzles]);

  const [selectedNozzle, setSelectedNozzle] = useState<number | null>(null);
  const [fillMode, setFillMode] = useState<FillMode>("full");
  const [vol, setVol]           = useState("25");
  const [amt, setAmt]           = useState("150000");

  /* reset form whenever the modal opens */
  useEffect(() => {
    if (!open) return;
    const init =
      initialNozzle != null && activeNozzles.some((n) => n.index === initialNozzle)
        ? initialNozzle
        : activeNozzles.length === 1
          ? (activeNozzles[0]?.index ?? null)
          : null;
    setSelectedNozzle(init);
    setFillMode("full");
    setVol("25");
    setAmt("150000");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const effectiveNozzle = selectedNozzle ?? (activeNozzles.length === 1 ? activeNozzles[0]!.index : null);
  const selectedSnap    = useMemo(
    () => activeNozzles.find((n) => n.index === effectiveNozzle) ?? null,
    [activeNozzles, effectiveNozzle],
  );
  const price        = selectedSnap?.price ?? 0;
  const productColor = selectedSnap?.product_color ?? "#888";

  const volNum = parseNum(vol);
  const amtNum = parseNum(amt);

  const canConfirm =
    effectiveNozzle != null &&
    (fillMode === "full" ||
      (fillMode === "volume" && volNum > 0) ||
      (fillMode === "amount" && amtNum > 0));

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

  /* projected totals */
  const projectedAmt = fillMode === "volume" && price > 0 && volNum > 0
    ? Math.round(volNum * price) : null;
  const projectedVol = fillMode === "amount" && price > 0 && amtNum > 0
    ? Math.round((amtNum / price) * 10) / 10 : null;

  /* accent colour drives the top border and the confirm button */
  const isPreauth = mode === "preauth";

  if (!open) return null;

  /* ── helpers ── */

  function StepBtn({ label, onClick }: { label: "+" | "-"; onClick: () => void }) {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border-primary/60 bg-bg-secondary text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary active:scale-95"
      >
        <img src={label === "+" ? plusIcon : minusIcon} alt="" aria-hidden className="h-4 w-4" draggable={false} />
      </button>
    );
  }

  function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-text-muted">
        {children}
      </p>
    );
  }

  /* ── render ── */
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${kolonkaTitle} — ${isPreauth ? t("authorize.preauthorize") : t("authorize.authorize")}`}
        className={[
          "flex w-full max-w-md flex-col overflow-hidden bg-bg-card",
          "border-t-[3px]",
          "rounded-t-2xl sm:rounded-2xl sm:border sm:border-t-[3px]",
          "shadow-[0_-8px_32px_rgb(0_0_0/0.25)] sm:shadow-card-hover",
          isPreauth ? "border-t-accent-amber sm:border-accent-amber" : "border-t-accent-emerald sm:border-accent-emerald",
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >

        {/* ── Header ── */}
        <div className="flex shrink-0 items-center justify-between border-b border-border-primary/60 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <img src={dispenserIcon} alt="" aria-hidden className="h-5 w-5 shrink-0 opacity-55" draggable={false} />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold uppercase tracking-wide text-text-primary">
                {kolonkaTitle}
              </p>
              <p className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
                {isPreauth ? t("authorize.preauthorize") : t("authorize.authorize")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border-primary/50 bg-bg-secondary text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            aria-label={t("saleSetup.cancel")}
          >
            <img src={xCircleIcon} alt="" aria-hidden className="h-4 w-4" draggable={false} />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">

          {/* Product selection */}
          {activeNozzles.length > 1 ? (
            <div>
              <SectionLabel>{t("saleSetup.productSelection")}</SectionLabel>
              <div className="flex flex-col gap-1.5">
                {activeNozzles.map((n) => {
                  const sel = effectiveNozzle === n.index;
                  return (
                    <button
                      key={n.index}
                      type="button"
                      onClick={() => setSelectedNozzle(n.index)}
                      className={[
                        "flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all",
                        sel
                          ? "border-accent-amber/60 bg-accent-amber/10 ring-1 ring-accent-amber/20"
                          : "border-border-primary/60 bg-bg-secondary/30 hover:border-border-primary hover:bg-bg-secondary/60",
                      ].join(" ")}
                    >
                      <span
                        className="h-3 w-3 shrink-0 rounded-full border border-border-secondary/40"
                        style={{ backgroundColor: n.product_color ?? "#888" }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
                        {n.product_name}
                      </span>
                      {sel && (
                        <img src={checkIcon} alt="" aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-60" draggable={false} />
                      )}
                      <span className="shrink-0 font-mono text-xs tabular-nums text-accent-blue">
                        {n.price > 0 ? `${fmtSum.format(n.price)} ${t("pumpForm.amountUnit")}` : "—"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : selectedSnap ? (
            /* Single nozzle — show as read-only confirmation row */
            <div className="flex items-center gap-3 rounded-xl border border-border-primary/60 bg-bg-secondary/30 px-4 py-3">
              <span
                className="h-3 w-3 shrink-0 rounded-full border border-border-secondary/40"
                style={{ backgroundColor: productColor }}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
                {selectedSnap.product_name}
              </span>
              <div className="shrink-0 text-right">
                <p className="font-mono text-sm font-bold tabular-nums text-accent-blue">
                  {price > 0 ? `${fmtSum.format(price)} ${t("pumpForm.amountUnit")}` : "—"}
                </p>
                {price > 0 && (
                  <p className="text-[10px] text-text-muted">{t("pumpForm.perLiter")}</p>
                )}
              </div>
            </div>
          ) : (
            <p className="rounded-xl border border-accent-amber/40 bg-accent-amber/10 px-4 py-3 text-sm text-accent-amber">
              {t("saleSetup.noProducts")}
            </p>
          )}

          {/* Fill mode */}
          <div>
            <SectionLabel>{t("saleSetup.fillMode")}</SectionLabel>
            <div className="rounded-xl border border-border-primary/60 bg-bg-input/60 p-1">
              <div className="grid grid-cols-3 gap-1">
                {(["full", "volume", "amount"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-active={fillMode === m}
                    onClick={() => setFillMode(m)}
                    className="pump-mode-pill px-2 py-2 text-xs"
                  >
                    <img
                      src={m === "full" ? fullTankIcon : m === "volume" ? dropletIcon : moneyIcon}
                      alt=""
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0"
                      draggable={false}
                    />
                    <span className="min-w-0 truncate">
                      {t(m === "full" ? "pumpForm.fillModeFull" : m === "volume" ? "pumpForm.fillModeVol" : "pumpForm.fillModeAmt")}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Volume input + presets */}
          {fillMode === "volume" && (
            <div className="flex flex-col gap-2">
              {/* Quick presets */}
              <div className="grid grid-cols-4 gap-1.5">
                {["10", "20", "30", "50"].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVol(v)}
                    className={[
                      "pump-quick-chip rounded-xl py-1.5 text-xs font-bold",
                      vol === v ? "border-accent-blue/60 bg-accent-blue/10 text-accent-blue" : "",
                    ].join(" ")}
                  >
                    {v} L
                  </button>
                ))}
              </div>
              {/* Stepper */}
              <div className="flex items-center gap-3">
                <StepBtn label="-" onClick={() => setVol((v) => String(Math.max(1, parseNum(v) - 5)))} />
                <div className="flex flex-1 items-center gap-2 rounded-xl border border-border-primary/60 bg-bg-input px-4 py-3">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={vol}
                    onChange={(e) => setVol(e.target.value)}
                    className="w-full bg-transparent text-center font-mono text-2xl font-black tabular-nums text-text-primary outline-none"
                    autoFocus
                  />
                  <span className="shrink-0 text-sm font-bold text-text-muted">L</span>
                </div>
                <StepBtn label="+" onClick={() => setVol((v) => String(parseNum(v) + 5))} />
              </div>
              {/* Projected amount */}
              {projectedAmt != null && (
                <p className="rounded-xl bg-bg-secondary/50 py-2 text-center font-mono text-sm font-semibold tabular-nums text-accent-blue">
                  ≈ {fmtSum.format(projectedAmt)} {t("pumpForm.amountUnit")}
                </p>
              )}
            </div>
          )}

          {/* Amount input + presets */}
          {fillMode === "amount" && (
            <div className="flex flex-col gap-2">
              {/* Quick presets */}
              <div className="grid grid-cols-4 gap-1.5">
                {["50000", "100000", "150000", "200000"].map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAmt(a)}
                    className={[
                      "pump-quick-chip rounded-xl py-1.5 text-xs font-bold",
                      amt === a ? "border-accent-blue/60 bg-accent-blue/10 text-accent-blue" : "",
                    ].join(" ")}
                  >
                    {Number(a) / 1000}k
                  </button>
                ))}
              </div>
              {/* Stepper */}
              <div className="flex items-center gap-3">
                <StepBtn label="-" onClick={() => setAmt((v) => String(Math.max(10000, parseNum(v) - 10000)))} />
                <div className="flex flex-1 items-center gap-2 rounded-xl border border-border-primary/60 bg-bg-input px-4 py-3">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={amt}
                    onChange={(e) => setAmt(e.target.value)}
                    className="w-full bg-transparent text-center font-mono text-2xl font-black tabular-nums text-text-primary outline-none"
                    autoFocus
                  />
                  <span className="shrink-0 text-sm font-bold text-text-muted">
                    {t("pumpForm.amountUnit")}
                  </span>
                </div>
                <StepBtn label="+" onClick={() => setAmt((v) => String(parseNum(v) + 10000))} />
              </div>
              {/* Projected volume */}
              {projectedVol != null && (
                <p className="rounded-xl bg-bg-secondary/50 py-2 text-center font-mono text-sm font-semibold tabular-nums text-text-secondary">
                  ≈ {projectedVol} L
                </p>
              )}
            </div>
          )}

          {/* Full-tank hint */}
          {fillMode === "full" && (
            <div className="rounded-xl border border-border-primary/50 bg-bg-input/40 px-4 py-3 text-center text-xs text-text-muted">
              {t("saleSetup.fullTankDesc")}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex shrink-0 gap-3 border-t border-border-primary/60 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-border-primary bg-bg-secondary py-3 text-sm font-bold uppercase tracking-wide text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <img src={xCircleIcon} alt="" aria-hidden className="h-4 w-4 shrink-0" draggable={false} />
            {t("saleSetup.cancel")}
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={handleConfirm}
            className={[
              "flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold uppercase tracking-wide",
              "transition disabled:cursor-not-allowed disabled:opacity-50",
              isPreauth
                ? "bg-accent-amber text-text-inverse hover:bg-accent-amber-light"
                : "btn-start-glow pump-start-button text-white",
            ].join(" ")}
          >
            <img src={playIcon} alt="" aria-hidden className="h-4 w-4 shrink-0" draggable={false} />
            {isPreauth ? t("authorize.preauthorize") : t("authorize.authorize")}
          </button>
        </div>
      </div>
    </div>
  );
}
