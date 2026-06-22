import { useTranslation } from "react-i18next";

type Props = {
  expectedProductName: string;
  liftedProductName: string;
  expectedColor?: string;
  liftedColor?: string;
  onClose?: () => void;
};

export function PreAuthNozzleMismatchAlert({
  expectedProductName,
  liftedProductName,
  expectedColor = "#888",
  liftedColor = "#888",
  onClose,
}: Props) {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      className="relative flex items-center gap-2 rounded-md border border-red-600 bg-red-950/70 py-1.5 pl-2.5 pr-9 shadow-[0_4px_16px_-6px_rgba(220,38,38,0.55)]"
    >
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" aria-hidden />
      <div className="min-w-0 flex-1 leading-tight">
        <span className="text-[11px] font-bold uppercase tracking-wider text-red-300">
          {t("mismatch.title")}
        </span>
        <p className="truncate text-sm font-medium text-red-100">
          <span className="inline-flex items-center gap-1 font-bold">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: expectedColor }} />
            {expectedProductName}
          </span>
          {" ≠ "}
          <span className="inline-flex items-center gap-1 font-bold text-red-300 line-through">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: liftedColor }} />
            {liftedProductName}
          </span>
        </p>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={t("mismatch.close", { defaultValue: "Close" })}
          className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-red-500/60 bg-red-900/70 text-base font-black leading-none text-red-100 transition-colors hover:bg-red-600 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
        >
          ✕
        </button>
      )}
    </div>
  );
}
