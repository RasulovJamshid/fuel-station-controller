import { useTranslation } from "react-i18next";

type Props = {
  minutesRemaining: number | null;
  onHandover: () => void;
  onEndShift: () => void;
};

export function ShiftWarningBanner({ minutesRemaining, onHandover, onEndShift }: Props) {
  const { t } = useTranslation();

  if (minutesRemaining == null) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-800/50 bg-amber-950/40 px-6 py-2">
      <div className="flex items-center gap-2 text-sm text-amber-200">
        <span className="animate-pulse">⚠</span>
        {t("shiftWarning.endsIn", { minutes: minutesRemaining })}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onHandover}
          className="rounded border border-amber-600/50 px-3 py-1 text-xs text-amber-200 hover:bg-amber-900/40"
        >
          {t("shiftWarning.handoverNow")}
        </button>
        <button
          type="button"
          onClick={onEndShift}
          className="rounded border border-red-700/50 px-3 py-1 text-xs text-red-200 hover:bg-red-950/40"
        >
          {t("shiftWarning.endShift")}
        </button>
      </div>
    </div>
  );
}
