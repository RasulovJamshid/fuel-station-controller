import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react";
import type { NozzleSnapshot } from "../types/api";
import { formatMoneyInput, parseMoney } from "../lib/money";
import type { AuthorizeRequest, FillMode } from "./DispenserCard";
import { ProductGradeTiles } from "./ProductGradeTiles";

const fmtSum = new Intl.NumberFormat("uz-UZ");

export type SaleSetupPanelProps = {
  fpId: string;
  activeNozzles: NozzleSnapshot[];
  initialNozzle?: number | null;
  initialFillMode?: FillMode;
  title?: string;
  subtitle?: string;
  confirmLabel: string;
  theme?: "amber" | "emerald";
  onConfirm: (req: AuthorizeRequest) => void;
  onCancel: () => void;
};

export function SaleSetupPanel({
  fpId,
  activeNozzles,
  initialNozzle = null,
  initialFillMode,
  title,
  subtitle,
  confirmLabel,
  theme = "amber",
  onConfirm,
  onCancel,
}: SaleSetupPanelProps) {
  const { t } = useTranslation();
  const formatPricePerLiter = (price: number) =>
    price <= 0 ? "—" : `${fmtSum.format(price)} ${t("product.perLiter")}`;
  const resolvedTitle = title ?? t("authorize.preauthorize");
  const resolvedSubtitle = subtitle ?? t("authorize.chooseProduct");
  const volInputRef = useRef<HTMLInputElement>(null);
  const amtInputRef = useRef<HTMLInputElement>(null);
  const shellClass =
    theme === "emerald"
      ? "border-2 border-emerald-600 bg-slate-750"
      : "border-2 border-amber-600 bg-slate-750";
  const headingClass = theme === "emerald" ? "text-emerald-400" : "text-amber-400";
  const submitClass =
    theme === "emerald"
      ? "bg-emerald-600 text-white border-2 border-emerald-700 hover:bg-emerald-500 hover:border-emerald-600"
      : "bg-amber-500 text-amber-950 border-2 border-amber-600 hover:bg-amber-400 hover:border-amber-500";
  const multipleProducts = activeNozzles.length > 1;

  const [selectedNozzle, setSelectedNozzle] = useState<number | null>(() => {
    if (initialNozzle != null && activeNozzles.some((n) => n.index === initialNozzle)) {
      return initialNozzle;
    }
    return activeNozzles.length === 1 ? (activeNozzles[0]?.index ?? null) : null;
  });
  const [fillMode, setFillMode] = useState<FillMode>(initialFillMode ?? "full");
  const [volLiters, setVolLiters] = useState("25");
  const [amtSum, setAmtSum] = useState("");

  useEffect(() => {
    if (initialNozzle != null && activeNozzles.some((n) => n.index === initialNozzle)) {
      setSelectedNozzle(initialNozzle);
    } else if (activeNozzles.length === 1) {
      setSelectedNozzle(activeNozzles[0]?.index ?? null);
    } else {
      setSelectedNozzle(null);
    }
    setFillMode(initialFillMode ?? "full");
    setVolLiters("25");
    setAmtSum("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when pump or hint changes
  }, [fpId, initialNozzle, initialFillMode]);

  const effectiveNozzle =
    selectedNozzle ?? (activeNozzles.length === 1 ? activeNozzles[0]!.index : null);

  const selectedSnap = useMemo(
    () => activeNozzles.find((n) => n.index === effectiveNozzle) ?? null,
    [activeNozzles, effectiveNozzle],
  );

  const displayPrice = selectedSnap?.price ?? 0;
  const productReady = effectiveNozzle != null && selectedSnap != null;

  const submit = () => {
    if (!productReady) return;

    let limitValue: number | null = null;
    if (fillMode === "volume") {
      const v = Number.parseFloat(volLiters.replace(",", "."));
      if (!Number.isFinite(v) || v <= 0) return;
      limitValue = v;
    } else if (fillMode === "amount") {
      const a = parseMoney(amtSum);
      if (!Number.isFinite(a) || a <= 0) return;
      limitValue = a;
    }

    onConfirm({
      fpId,
      nozzleIndex: effectiveNozzle,
      fillMode,
      limitValue,
      priceOverride: null,
    });
  };

  useEffect(() => {
    if (fillMode === "amount" && amtSum === "" && displayPrice > 0) {
      setAmtSum(formatMoneyInput(Math.round(displayPrice * 10)));
    }
  }, [fillMode, displayPrice, amtSum]);

  // Auto-focus input when mode changes
  useEffect(() => {
    if (fillMode === "volume") {
      setTimeout(() => volInputRef.current?.focus(), 100);
    } else if (fillMode === "amount") {
      setTimeout(() => amtInputRef.current?.focus(), 100);
    }
  }, [fillMode]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if (e.key === 'Enter' && productReady) {
        submit();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [productReady, onCancel, submit]);

  const modeBtn = (m: FillMode, label: string) => (
    <button
      key={m}
      type="button"
      onClick={() => setFillMode(m)}
      className={`flex-1 rounded-md border-2 px-2 py-2.5 text-xs font-bold uppercase tracking-wider transition-all duration-200 ${
        fillMode === m
          ? "border-indigo-500 bg-indigo-600 text-white shadow-md"
          : "border-slate-600 bg-slate-700 text-slate-400 hover:border-slate-500 hover:bg-slate-600 hover:text-slate-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className={`flex flex-col gap-4 p-4 ${shellClass}`}>
      <div>
        <h3 className={`text-sm font-bold uppercase tracking-widest ${headingClass}`}>{resolvedTitle}</h3>
        <p className="mt-0.5 text-xs text-slate-400">{resolvedSubtitle}</p>
      </div>

      {multipleProducts ? (
        <div>
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
            {t("saleSetup.productSelection")}
          </div>
          <ProductGradeTiles
            nozzles={activeNozzles}
            selectedIndex={effectiveNozzle}
            onSelect={setSelectedNozzle}
            layout={activeNozzles.length === 2 ? "grid" : "stack"}
          />
        </div>
      ) : selectedSnap ? (
        <div className="overflow-hidden rounded-md border-2 border-slate-600 bg-slate-750">
          <div className="h-2 w-full border-b border-slate-600" style={{ backgroundColor: selectedSnap.product_color ?? "#888" }} />
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">{t("saleSetup.selectedProduct")}</div>
              <span className="font-bold text-slate-100">{selectedSnap.product_name}</span>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">{t("saleSetup.rate")}</div>
              <span className="font-mono text-sm font-bold text-amber-300 tabular-nums">
                {formatPricePerLiter(displayPrice)}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-amber-400 border-2 border-amber-600/50 bg-amber-950/30 px-3 py-2 rounded-md">{t("saleSetup.noProducts")}</p>
      )}

      <div>
        {!productReady && multipleProducts && (
          <p className="mb-2 text-xs text-amber-400">{t("saleSetup.selectProduct")}</p>
        )}
        <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">{t("saleSetup.fillMode")}</div>
        <div className="mb-3 flex gap-2">
          {modeBtn("full", t("saleSetup.fullTank"))}
          {modeBtn("volume", t("saleSetup.volume"))}
          {modeBtn("amount", t("saleSetup.amount"))}
        </div>

        {fillMode === "volume" && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-4 gap-2">
              {["15", "25", "40", "75"].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVolLiters(v)}
                  className={`rounded-md border-2 py-2 text-sm font-bold transition-all duration-200 ${
                    volLiters === v
                      ? "border-indigo-500 bg-indigo-600 text-white"
                      : "border-slate-600 bg-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-600"
                  }`}
                >
                  {v}L
                </button>
              ))}
            </div>
            <div className="relative">
              <input
                ref={volInputRef}
                type="text"
                inputMode="decimal"
                value={volLiters}
                onChange={(e) => setVolLiters(e.target.value)}
                className="w-full rounded-md border-2 border-slate-600 bg-slate-800 px-4 py-3 pr-12 text-center text-xl font-black text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:bg-slate-700 transition-colors"
                placeholder={t("saleSetup.litersPlaceholder")}
              />
              {volLiters && Number.parseFloat(volLiters) > 0 && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-5 h-5 bg-emerald-500 rounded-full flex items-center justify-center">
                    <Check className="w-3 h-3 text-white" />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {fillMode === "amount" && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-4 gap-2">
              {["75000", "150000", "250000", "500000"].map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAmtSum(formatMoneyInput(a))}
                  className={`rounded-md border-2 py-2 text-sm font-bold transition-all duration-200 ${
                    parseMoney(amtSum) === Number(a)
                      ? "border-indigo-500 bg-indigo-600 text-white"
                      : "border-slate-600 bg-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-600"
                  }`}
                >
                  {formatMoneyInput(a)}
                </button>
              ))}
            </div>
            <div className="relative">
              <input
                ref={amtInputRef}
                type="text"
                inputMode="numeric"
                value={amtSum}
                onChange={(e) => setAmtSum(formatMoneyInput(e.target.value))}
                className="w-full rounded-md border-2 border-slate-600 bg-slate-800 px-4 py-3 pr-12 text-center text-xl font-black text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:bg-slate-700 transition-colors"
                placeholder={t("saleSetup.amountPlaceholder")}
              />
              {amtSum && parseMoney(amtSum) > 0 && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-5 h-5 bg-emerald-500 rounded-full flex items-center justify-center">
                    <Check className="w-3 h-3 text-white" />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {fillMode === "full" && (
          <p className="rounded-md border-2 border-slate-600 bg-slate-750 px-3 py-4 text-center text-xs font-medium text-slate-400">
            {t("saleSetup.fullTankDesc")}
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md px-4 py-3.5 text-base font-semibold uppercase tracking-wider text-slate-200 transition-all duration-200 shadow-lg border-2 border-slate-500 bg-slate-600 hover:border-slate-400 hover:bg-slate-500 hover:text-white hover:shadow-xl"
        >
          <span className="flex items-center justify-center gap-2">
            <X className="h-5 w-5" />
            {t("saleSetup.cancel")}
          </span>
        </button>
        <button
          type="button"
          disabled={!productReady}
          onClick={submit}
          className={`flex-1 rounded-md px-4 py-3.5 text-base font-black uppercase tracking-wider shadow-lg transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${submitClass} ${productReady ? 'hover:shadow-xl' : ''}`}
        >
          <span className="flex items-center justify-center gap-2">
            <Check className="h-5 w-5" />
            {productReady ? confirmLabel : t("saleSetup.selectProductBtn")}
          </span>
        </button>
      </div>
    </div>
  );
}
