type Props = {
  expectedProductName: string;
  liftedProductName: string;
  expectedColor?: string;
  liftedColor?: string;
};

export function PreAuthNozzleMismatchAlert({
  expectedProductName,
  liftedProductName,
  expectedColor = "#888",
  liftedColor = "#888",
}: Props) {
  return (
    <div
      role="alert"
      className="rounded-md border-2 border-red-600 bg-red-950/40 p-4"
    >
      <div className="flex items-center gap-2 mb-2">
        <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
        <p className="text-sm font-bold uppercase tracking-wider text-red-200">FUEL GRADE MISMATCH</p>
      </div>
      <p className="mt-1 text-sm leading-snug text-red-100/95">
        This sale is for <span className="font-bold text-white">{expectedProductName}</span>, not{" "}
        <span className="font-bold text-white">{liftedProductName}</span>.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="overflow-hidden rounded-md border-2 border-emerald-600 bg-slate-750">
          <div className="h-2 w-full border-b border-slate-600" style={{ backgroundColor: expectedColor }} />
          <div className="px-3 py-3 text-center">
            <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">
              USE THIS NOZZLE
            </p>
            <p className="text-base font-black text-slate-50">{expectedProductName}</p>
          </div>
        </div>
        <div className="overflow-hidden rounded-md border-2 border-red-600 bg-slate-750 opacity-80">
          <div className="h-2 w-full border-b border-slate-600" style={{ backgroundColor: liftedColor }} />
          <div className="px-3 py-3 text-center">
            <p className="text-[10px] font-bold uppercase tracking-wider text-red-400 mb-1">
              WRONG NOZZLE
            </p>
            <p className="text-base font-black text-slate-400 line-through">
              {liftedProductName}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-3 p-2 bg-slate-800/50 rounded-md border border-slate-600">
        <p className="text-xs font-medium text-slate-300 text-center">
          ⚠️ HOLSTER THE NOZZLE, THEN LIFT THE CORRECT HOSE TO START THE FILL
        </p>
      </div>
    </div>
  );
}
