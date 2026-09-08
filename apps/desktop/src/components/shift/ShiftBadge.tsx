import { useTranslation } from "react-i18next";
import type { Shift, ShiftMode } from "../../types/api";

type Props = {
  shift: Shift | null;
  mode: ShiftMode;
  onStartShift: () => void;
  onEndShift: () => void;
  onHandover: () => void;
};

export function ShiftBadge({ shift, mode, onStartShift, onEndShift, onHandover }: Props) {
  const { t } = useTranslation();

  if (mode === "disabled") return null;

  if (!shift) {
    return (
      <button
        type="button"
        onClick={onStartShift}
        className="flex items-center gap-2 rounded border border-amber-500/45 bg-transparent px-3 py-1.5 text-sm text-amber-300 transition-colors hover:bg-amber-500/10"
      >
        <span className="h-2 w-2 rounded-full bg-amber-400" />
        {t("shiftBadge.noActiveShift")}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-border-primary/70 bg-transparent px-3 py-1.5">
      <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
      <span className="max-w-[12rem] truncate text-sm text-slate-200">
        {shift.operator_name}
        {shift.shift_name ? (
          <span className="ml-1 text-slate-500">· {shift.shift_name}</span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onHandover}
        className="border-l border-border-primary pl-2 text-xs text-slate-400 transition-colors hover:text-slate-200"
      >
        {t("shiftBadge.handover")}
      </button>
      <button type="button" onClick={onEndShift} className="border-l border-border-primary pl-2 text-xs text-red-400 transition-colors hover:text-red-300">
        {t("shiftBadge.endShift")}
      </button>
    </div>
  );
}
