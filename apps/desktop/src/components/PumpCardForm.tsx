import { useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import chevronDownIcon from "@/assets/icons/chevron-down.svg";
import fuelTypeIcon from "@/assets/icons/fuel.svg";
import dropletIcon from "@/assets/icons/fuel.svg";
import fullTankIcon from "@/assets/icons/full-tank.svg";
import minusIcon from "@/assets/icons/minus.svg";
import moneyIcon from "@/assets/icons/money.svg";
import plusIcon from "@/assets/icons/plus.svg";
import type { NozzleSnapshot } from "../types/api";
import type { AuthorizeRequest, FillMode } from "./DispenserCard";

const fmtSum = new Intl.NumberFormat("uz-UZ");

function parseNum(s: string): number {
  const v = Number.parseFloat(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(v) ? v : 0;
}

type Props = {
  fpId: string;
  activeNozzles: NozzleSnapshot[];
  initialNozzle?: number | null;
  compact?: boolean;
  disabled?: boolean;
  onStart: (req: AuthorizeRequest) => void;
  /** Called whenever the start-button's enabled state or handler changes. */
  onReadyChange: (info: { disabled: boolean; onStart: () => void }) => void;
};

function FieldLabel({
  icon,
  children,
  compact,
}: {
  icon: ReactNode;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 font-medium text-accent-blue/90 ${compact ? "text-xs" : "text-sm"}`}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}

function StepperRow({
  value,
  unit,
  onChange,
  onInc,
  onDec,
  disabled,
  compact,
  autoFocus,
}: {
  value: string;
  unit: string;
  onChange: (v: string) => void;
  onInc: () => void;
  onDec: () => void;
  disabled?: boolean;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const didAutoFocusRef = useRef(false);
  
  useEffect(() => {
    if (autoFocus && inputRef.current && !disabled && !didAutoFocusRef.current) {
      inputRef.current.focus();
      didAutoFocusRef.current = true;
    }
  }, [autoFocus, disabled]);

  const btnClass = `flex shrink-0 items-center justify-center rounded-md border border-border-primary bg-bg-input text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-40 ${compact ? "h-10 w-10" : "h-12 w-12"}`;
  return (
    <div className="flex items-stretch gap-1">
      <button type="button" className={btnClass} disabled={disabled} onClick={onDec} aria-label="Decrease">
        <img
          src={minusIcon}
          alt=""
          aria-hidden
          className={compact ? "h-4 w-4" : "h-5 w-5"}
          draggable={false}
        />
      </button>
      <div
        className={`flex min-w-0 flex-1 items-center rounded-md border border-border-primary bg-bg-input px-3 ${compact ? "h-10" : "h-12"}`}
      >
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`min-w-0 flex-1 bg-transparent text-center font-mono font-bold tabular-nums text-text-primary outline-none ${compact ? "text-lg" : "text-xl"}`}
        />
        <span className={`shrink-0 font-bold text-text-muted ${compact ? "text-xs" : "text-sm"}`}>
          {unit}
        </span>
      </div>
      <button type="button" className={btnClass} disabled={disabled} onClick={onInc} aria-label="Increase">
        <img
          src={plusIcon}
          alt=""
          aria-hidden
          className={compact ? "h-4 w-4" : "h-5 w-5"}
          draggable={false}
        />
      </button>
    </div>
  );
}

export function PumpCardForm({
  fpId,
  activeNozzles,
  initialNozzle = null,
  compact = false,
  disabled = false,
  onStart,
  onReadyChange,
}: Props) {
  const [selectedNozzle, setSelectedNozzle] = useState<number | null>(() => {
    if (initialNozzle != null && activeNozzles.some((n) => n.index === initialNozzle)) {
      return initialNozzle;
    }
    return activeNozzles.length === 1 ? (activeNozzles[0]?.index ?? null) : null;
  });
  const [fillMode, setFillMode] = useState<FillMode>("volume");
  const [volLiters, setVolLiters] = useState("10");
  const [amtSum, setAmtSum] = useState("150000");

  useEffect(() => {
    if (initialNozzle != null && activeNozzles.some((n) => n.index === initialNozzle)) {
      setSelectedNozzle(initialNozzle);
    } else if (activeNozzles.length === 1) {
      setSelectedNozzle(activeNozzles[0]?.index ?? null);
    }
  }, [fpId, initialNozzle, activeNozzles]);

  const effectiveNozzle =
    selectedNozzle ?? (activeNozzles.length === 1 ? activeNozzles[0]!.index : null);

  const selectedSnap = useMemo(
    () => activeNozzles.find((n) => n.index === effectiveNozzle) ?? null,
    [activeNozzles, effectiveNozzle],
  );

  const price = selectedSnap?.price ?? 0;
  const productColor = selectedSnap?.product_color ?? "#3b82f6";

  const syncAmountFromVolume = useCallback(
    (liters: string) => {
      const v = parseNum(liters);
      if (price > 0 && v > 0) setAmtSum(String(Math.round(v * price)));
    },
    [price],
  );

  const syncVolumeFromAmount = useCallback(
    (sum: string) => {
      const a = parseNum(sum);
      if (price > 0 && a > 0) setVolLiters(String(Math.round((a / price) * 10) / 10));
    },
    [price],
  );

  useEffect(() => {
    if (fillMode === "volume") syncAmountFromVolume(volLiters);
  }, [price, fillMode, volLiters, syncAmountFromVolume]);

  useEffect(() => {
    if (fillMode === "amount") syncVolumeFromAmount(amtSum);
  }, [price, fillMode, amtSum, syncVolumeFromAmount]);

  const projectedAmount = useMemo(() => {
    if (price <= 0) return null;
    if (fillMode === "volume") {
      const liters = parseNum(volLiters);
      if (liters <= 0) return null;
      return Math.round(liters * price);
    }
    if (fillMode === "amount") {
      const amount = parseNum(amtSum);
      return amount > 0 ? Math.round(amount) : null;
    }
    return null;
  }, [fillMode, volLiters, amtSum, price]);

  const projectedLiters = useMemo(() => {
    if (price <= 0) return null;
    if (fillMode === "volume") {
      const liters = parseNum(volLiters);
      return liters > 0 ? liters : null;
    }
    if (fillMode === "amount") {
      const amount = parseNum(amtSum);
      return amount > 0 ? Math.round((amount / price) * 10) / 10 : null;
    }
    return null;
  }, [fillMode, volLiters, amtSum, price]);

  const startDisabled =
    disabled ||
    !selectedSnap ||
    (fillMode === "volume" && parseNum(volLiters) <= 0) ||
    (fillMode === "amount" && parseNum(amtSum) <= 0);

  const hasSelection = Boolean(selectedSnap);
  const showResetSelection = activeNozzles.length > 1 && selectedNozzle != null;

  const handleResetSelection = useCallback(() => {
    setSelectedNozzle(null);
  }, []);

  const handleStart = useCallback(() => {
    if (effectiveNozzle == null || !selectedSnap) return;
    let limitValue: number | null = null;
    if (fillMode === "volume") {
      const v = parseNum(volLiters);
      if (v <= 0) return;
      limitValue = v;
    } else if (fillMode === "amount") {
      const a = parseNum(amtSum);
      if (a <= 0) return;
      limitValue = a;
    }
    onStart({ fpId, nozzleIndex: effectiveNozzle, fillMode, limitValue, priceOverride: null });
  }, [effectiveNozzle, selectedSnap, fillMode, volLiters, amtSum, onStart, fpId]);

  useEffect(() => {
    onReadyChange({ disabled: startDisabled, onStart: handleStart });
  }, [startDisabled, handleStart, onReadyChange]);

  const volStep = compact ? 1 : 5;
  const amtStep = compact ? 10000 : 25000;

  const { t } = useTranslation();

  if (activeNozzles.length === 0) {
    return (
      <p className="rounded-lg border border-border-primary bg-bg-input/50 px-3 py-4 text-center text-xs text-text-muted">
        {t("pumpForm.noActiveProducts")}
      </p>
    );
  }

  const minHeightClass = compact ? "min-h-[240px]" : "min-h-[320px]";

  return (
    <div className={`flex w-full min-w-0 flex-1 flex-col ${minHeightClass} ${compact ? "gap-2" : "gap-3"}`}>
      {/* Fuel type */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel
              icon={<img src={fuelTypeIcon} alt="" aria-hidden className="h-3.5 w-3.5" draggable={false} />}
              compact={compact}
            >
              {t("pumpForm.fuelType")}
            </FieldLabel>
            {showResetSelection ? (
              <button
                type="button"
                disabled={disabled}
                onClick={handleResetSelection}
                className={`group inline-flex items-center gap-1 rounded-full bg-text-tertiary/15 text-xs font-semibold uppercase tracking-wide text-text-tertiary transition hover:bg-text-tertiary/25 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 ${
                  compact ? "px-2 py-0.5" : "px-3 py-0.5"
                }`}
              >
                {t("pumpForm.clearSelection")}
              </button>
            ) : null}
          </div>
          <div className="relative">
            <span
              className="pointer-events-none absolute left-2.5 top-1/2 z-[1] h-2.5 w-2.5 -translate-y-1/2 rounded-full"
              style={{ backgroundColor: productColor }}
              aria-hidden
            />
            <select
              disabled={disabled || activeNozzles.length <= 1}
              value={effectiveNozzle ?? ""}
              onChange={(e) => {
                const raw = e.target.value;
                setSelectedNozzle(raw ? Number(raw) : null);
              }}
              className={`w-full appearance-none rounded-lg border border-border-primary bg-bg-input py-2 pl-7 pr-9 font-semibold text-text-primary outline-none focus:border-accent-blue/60 ${compact ? "text-sm" : "text-base"}`}
            >
              {activeNozzles.length > 1 && !effectiveNozzle ? (
                <option value="">—</option>
              ) : null}
              {activeNozzles.map((n) => (
                <option key={n.index} value={n.index}>
                  {n.product_name}
                </option>
              ))}
            </select>
            <img
              src={chevronDownIcon}
              alt=""
              aria-hidden
              className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2"
              draggable={false}
            />
          </div>
        </div>

        {/* Product + price preview */}
        <div className="rounded-lg border border-border-primary/70 bg-bg-input/60 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className={`truncate font-semibold text-text-primary ${compact ? "text-sm" : "text-base"}`}>
                {selectedSnap?.product_name ?? t("pumpForm.selectProductPlaceholder")}
              </p>
              <p className={`text-text-muted ${compact ? "text-xs" : "text-sm"}`}>
                {effectiveNozzle != null ? t("pumpForm.nozzleLabel", { n: effectiveNozzle }) : "—"}
              </p>
            </div>
            <div className="text-right">
              <p className={`font-mono font-bold tabular-nums text-accent-blue ${compact ? "text-sm" : "text-base"}`}>
                {price > 0 ? `${fmtSum.format(price)} ${t("pumpForm.amountUnit")}` : "—"}
              </p>
              {price > 0 && (
                <p className={`text-text-muted ${compact ? "text-xs" : "text-sm"}`}>{t("pumpForm.perLiter")}</p>
              )}
            </div>
          </div>
        </div>

        {hasSelection ? (
          <>
            {/* Fill mode selector */}
            <div className="rounded-xl border border-border-primary/70 bg-bg-input/70 p-1">
              <div className="grid grid-cols-3 gap-1">
                <button
                  type="button"
                  disabled={disabled}
                  data-active={fillMode === "full"}
                  title={t("pumpForm.fullTank")}
                  className={`pump-mode-pill ${compact ? "px-1.5 py-1.5 text-xs" : "px-2 py-2 text-sm"}`}
                  onClick={() => setFillMode("full")}
                >
                  <img
                    src={fullTankIcon}
                    alt=""
                    aria-hidden
                    className={compact ? "h-3.5 w-3.5 shrink-0" : "h-3.5 w-3.5 shrink-0"}
                    draggable={false}
                  />
                  {compact
                    ? <span className="truncate">{t("pumpForm.fillModeFull")}</span>
                    : t("pumpForm.fullTank")}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  data-active={fillMode === "volume"}
                  title={t("pumpForm.fuelVolume")}
                  className={`pump-mode-pill ${compact ? "px-1.5 py-1.5 text-xs" : "px-2 py-2 text-sm"}`}
                  onClick={() => setFillMode("volume")}
                >
                  <img
                    src={dropletIcon}
                    alt=""
                    aria-hidden
                    className={compact ? "h-3.5 w-3.5 shrink-0" : "h-3.5 w-3.5 shrink-0"}
                    draggable={false}
                  />
                  {compact
                    ? <span className="truncate">{t("pumpForm.fillModeVol")}</span>
                    : t("pumpForm.liters")}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  data-active={fillMode === "amount"}
                  title={t("pumpForm.amount")}
                  className={`pump-mode-pill ${compact ? "px-1.5 py-1.5 text-xs" : "px-2 py-2 text-sm"}`}
                  onClick={() => setFillMode("amount")}
                >
                  <img
                    src={moneyIcon}
                    alt=""
                    aria-hidden
                    className={compact ? "h-3.5 w-3.5 shrink-0" : "h-3.5 w-3.5 shrink-0"}
                    draggable={false}
                  />
                  {compact
                    ? <span className="truncate">{t("pumpForm.fillModeAmt")}</span>
                    : t("pumpForm.amount")}
                </button>
              </div>
            </div>

            {fillMode === "volume" && (
              <div className="flex flex-col gap-1.5">
                <FieldLabel
                  icon={
                    <img
                      src={dropletIcon}
                      alt=""
                      aria-hidden
                      className="h-3.5 w-3.5 opacity-80"
                      draggable={false}
                    />
                  }
                  compact={compact}
                >
                  {t("pumpForm.fuelVolume")}
                </FieldLabel>
                <StepperRow
                  autoFocus
                  value={volLiters}
                  unit="L"
                  disabled={disabled}
                  compact={compact}
                  onChange={(v) => {
                    setVolLiters(v);
                    syncAmountFromVolume(v);
                  }}
                  onDec={() => {
                    const next = Math.max(1, parseNum(volLiters) - volStep);
                    const s = String(next);
                    setVolLiters(s);
                    syncAmountFromVolume(s);
                  }}
                  onInc={() => {
                    const next = parseNum(volLiters) + volStep;
                    const s = String(next);
                    setVolLiters(s);
                    syncAmountFromVolume(s);
                  }}
                />
              </div>
            )}

            {fillMode === "amount" && (
              <div className="flex flex-col gap-1.5">
                <FieldLabel
                  icon={<img src={moneyIcon} alt="" aria-hidden className="h-3.5 w-3.5" draggable={false} />}
                  compact={compact}
                >
                  {t("pumpForm.fuelAmount")}
                </FieldLabel>
                <StepperRow
                  autoFocus
                  value={amtSum}
                  unit={t("pumpForm.amountUnit")}
                  disabled={disabled}
                  compact={compact}
                  onChange={(v) => {
                    setAmtSum(v);
                    syncVolumeFromAmount(v);
                  }}
                  onDec={() => {
                    const next = Math.max(amtStep, parseNum(amtSum) - amtStep);
                    const s = String(next);
                    setAmtSum(s);
                    syncVolumeFromAmount(s);
                  }}
                  onInc={() => {
                    const next = parseNum(amtSum) + amtStep;
                    const s = String(next);
                    setAmtSum(s);
                    syncVolumeFromAmount(s);
                  }}
                />
              </div>
            )}

            {fillMode === "full" && (
              <div className="rounded-lg border border-accent-blue/40 bg-accent-blue/10 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-semibold text-accent-blue ${compact ? "text-xs" : "text-sm"}`}>
                    {t("pumpForm.fullTankMode")}
                  </span>
                  <img
                    src={fullTankIcon}
                    alt=""
                    aria-hidden
                    className={compact ? "h-4 w-4" : "h-5 w-5"}
                    draggable={false}
                  />
                </div>
                <p className={`mt-0.5 text-text-muted ${compact ? "text-xs" : "text-sm"}`}>
                  {t("pumpForm.fullTankDesc")}
                </p>
              </div>
            )}

            {/* Live summary (limit modes only) */}
            {fillMode !== "full" && (
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-border-primary/70 bg-bg-input/45 p-2">
                <div>
                  <p className={`text-text-muted ${compact ? "text-xs" : "text-sm"}`}>{t("pumpForm.selectedMode")}</p>
                  <p className={`font-semibold text-text-primary ${compact ? "text-sm" : "text-base"}`}>
                    {fillMode === "volume" ? t("pumpForm.byVolume") : t("pumpForm.byAmount")}
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-text-muted ${compact ? "text-xs" : "text-sm"}`}>{t("pumpForm.liters")}</p>
                  <p className={`font-mono font-semibold tabular-nums text-text-primary ${compact ? "text-sm" : "text-base"}`}>
                    {projectedLiters != null ? `${projectedLiters.toFixed(1)} L` : "—"}
                  </p>
                </div>
                <div className="col-span-2">
                  <p className={`text-text-muted ${compact ? "text-xs" : "text-sm"}`}>{t("pumpForm.amount")}</p>
                  <p className={`font-mono font-bold tabular-nums text-accent-amber ${compact ? "text-sm" : "text-base"}`}>
                    {projectedAmount != null ? `${fmtSum.format(projectedAmount)} ${t("pumpForm.amountUnit")}` : "—"}
                  </p>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-border-primary/70 bg-bg-input/40 px-3 py-4 text-center text-sm font-medium text-text-secondary">
            {t("pumpForm.selectProductPrompt")}
          </p>
        )}
    </div>
  );
}

/** Progress block — three modes: volume-limit bar, amount-limit bar, full-fill live counter. */
export function PumpCardProgress({
  volume,
  amount,
  targetLiters,
  targetAmount,
  compact,
}: {
  volume: number;
  amount?: number;
  targetLiters: number | null;
  targetAmount?: number | null;
  compact?: boolean;
}) {
  const { t } = useTranslation();

  // ── Volume-limit mode ──────────────────────────────────────────────────────
  if (targetLiters != null && targetLiters > 0) {
    const pct = Math.min(100, (volume / targetLiters) * 100);
    return (
      <div className={`shrink-0 ${compact ? "mt-2" : "mt-3"}`}>
        <div className="mb-1 flex items-center justify-between">
          <span className={`font-medium text-text-muted ${compact ? "text-xs" : "text-sm"}`}>{t("pumpForm.filled")}</span>
          <span className={`font-bold tabular-nums text-accent-amber ${compact ? "text-sm" : "text-base"}`}>
            {volume.toFixed(2)} L
          </span>
        </div>
        <div className="progress-track h-4 overflow-hidden rounded-full">
          <div className="progress-fill h-full rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
        <div className={`mt-0.5 flex justify-between font-mono tabular-nums text-text-muted ${compact ? "text-[10px]" : "text-xs"}`}>
          <span>0</span>
          <span>{Math.round(pct)}%</span>
          <span>{targetLiters} L</span>
        </div>
      </div>
    );
  }

  // ── Amount-limit mode ──────────────────────────────────────────────────────
  if (targetAmount != null && targetAmount > 0 && amount != null) {
    const pct = Math.min(100, (amount / targetAmount) * 100);
    return (
      <div className={`shrink-0 ${compact ? "mt-2" : "mt-3"}`}>
        <div className="mb-1 flex items-center justify-between">
          <span className={`font-medium text-text-muted ${compact ? "text-xs" : "text-sm"}`}>{t("pumpForm.filled")}</span>
          <span className={`font-bold tabular-nums text-accent-amber ${compact ? "text-sm" : "text-base"}`}>
            {volume.toFixed(2)} L
          </span>
        </div>
        <div className="progress-track h-4 overflow-hidden rounded-full">
          <div className="progress-fill h-full rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
        <div className={`mt-0.5 flex justify-between font-mono tabular-nums text-text-muted ${compact ? "text-[10px]" : "text-xs"}`}>
          <span>0</span>
          <span>{Math.round(pct)}%</span>
          <span>{fmtSum.format(targetAmount)} {t("pumpForm.amountUnit")}</span>
        </div>
      </div>
    );
  }

  // ── Full-fill / no-limit: live counter ────────────────────────────────────
  return (
    <div className={`shrink-0 rounded-lg border border-border-primary/60 bg-bg-input/45 px-3 py-2 ${compact ? "mt-2" : "mt-3"}`}>
      <div className="mb-1 flex items-center justify-between">
        <span className={`font-bold uppercase tracking-wide text-text-muted ${compact ? "text-[10px]" : "text-xs"}`}>{t("pumpForm.filling")}</span>
        <span className="text-[10px] text-accent-emerald animate-pulse">●</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={`font-mono font-bold tabular-nums text-accent-amber ${compact ? "text-xl" : "text-2xl"}`}>
          {volume.toFixed(2)}
        </span>
        <span className={`font-semibold text-text-muted ${compact ? "text-xs" : "text-sm"}`}>L</span>
        {amount != null && amount > 0 && (
          <span className={`ml-auto font-mono tabular-nums text-text-secondary ${compact ? "text-xs" : "text-sm"}`}>
            {fmtSum.format(amount)} {t("pumpForm.amountUnit")}
          </span>
        )}
      </div>
    </div>
  );
}
