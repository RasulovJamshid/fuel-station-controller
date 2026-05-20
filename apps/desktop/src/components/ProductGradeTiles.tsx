import type { NozzleSnapshot } from "../types/api";

const fmtSum = new Intl.NumberFormat("uz-UZ");

function formatPricePerLiter(price: number): string {
  if (price <= 0) return "—";
  return `${fmtSum.format(price)} SUM/L`;
}

type Props = {
  nozzles: NozzleSnapshot[];
  selectedIndex: number | null;
  onSelect: (nozzleIndex: number) => void;
  /** stack = one product per row (best for 3+ grades) */
  layout?: "grid" | "stack";
};

export function ProductGradeTiles({
  nozzles,
  selectedIndex,
  onSelect,
  layout = "stack",
}: Props) {
  const containerClass =
    layout === "grid"
      ? "grid grid-cols-2 gap-2"
      : "flex flex-col gap-2";

  return (
    <div className={containerClass} role="listbox" aria-label="Fuel products">
      {nozzles.map((n) => {
        const selected = selectedIndex === n.index;
        return (
          <button
            key={n.index}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => onSelect(n.index)}
            className={`group relative flex w-full items-stretch overflow-hidden rounded-md border-2 text-left transition-all duration-200 ease-out ${
              selected
                ? "border-amber-400 bg-slate-750 shadow-sm hover:border-amber-300 hover:bg-slate-700 hover:shadow-md"
                : "border-slate-600 bg-slate-700 hover:border-slate-400 hover:bg-slate-600 hover:shadow-md active:border-slate-300 active:bg-slate-500"
            }`}
          >
            <div
              className="w-3 shrink-0 transition-all duration-300 border-r-2 border-slate-600"
              style={{
                backgroundColor: n.product_color ?? "#888",
              }}
            />
            <div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className={`font-bold tracking-tight transition-colors duration-300 ${selected ? "text-amber-100" : "text-slate-100 group-hover:text-white"}`}>
                  {n.product_name}
                </div>
                <div className={`text-xs font-medium mt-1 ${selected ? "text-amber-300" : "text-slate-400 group-hover:text-slate-300"}`}>
                  GRADE {n.index}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div
                  className={`font-mono font-bold tabular-nums transition-colors duration-300 ${
                    selected ? "text-amber-300" : "text-slate-300 group-hover:text-slate-200"
                  }`}
                >
                  {formatPricePerLiter(n.price)}
                </div>
                <div className={`text-xs font-medium mt-1 ${selected ? "text-amber-400" : "text-slate-500"}`}>
                  NOZZLE {n.index}
                </div>
              </div>
            </div>
            {selected && (
              <div className="absolute top-2 right-2">
                <div className="w-2 h-2 bg-amber-400 rounded-full animate-pulse"></div>
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
