import type { Shift, ShiftMode } from "../../types/api";

type Props = {
  shift: Shift | null;
  mode: ShiftMode;
  onStartShift: () => void;
  onEndShift: () => void;
  onHandover: () => void;
};

export function ShiftBadge({ shift, mode, onStartShift, onEndShift, onHandover }: Props) {
  if (mode === "disabled") return null;

  if (!shift) {
    return (
      <button
        type="button"
        onClick={onStartShift}
        className="flex items-center gap-2 rounded-md border border-amber-500/40 px-3 py-1.5 text-sm text-amber-300 hover:bg-amber-500/10"
      >
        <span className="h-2 w-2 rounded-full bg-amber-400" />
        No active shift — Start
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-3 py-1.5">
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
        className="text-xs text-slate-400 hover:text-slate-200"
      >
        Handover
      </button>
      <button type="button" onClick={onEndShift} className="text-xs text-red-400 hover:text-red-300">
        End shift
      </button>
    </div>
  );
}
