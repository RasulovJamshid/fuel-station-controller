export type WorkspaceTabId =
  | "dispensers"
  | "shift"
  | "reservoirs"
  | "history"
  | "today"
  | "admin";

export type WorkspaceTabDef = {
  id: WorkspaceTabId;
  label: string;
  /** Short label used in small-screen mode (optional; falls back to label). */
  shortLabel?: string;
  primary?: boolean;
};

type WorkspaceNavProps = {
  tabs: WorkspaceTabDef[];
  active: WorkspaceTabId;
  onSelect: (id: WorkspaceTabId) => void;
  smallScreen?: boolean;
};

/** Bottom workspace tab bar — primary navigation for the operator shell. */
export function WorkspaceNav({ tabs, active, onSelect, smallScreen = false }: WorkspaceNavProps) {
  const ops = tabs.filter((t) => t.id !== "admin");
  const admin = tabs.find((t) => t.id === "admin");

  const navPy = smallScreen ? "py-1" : "py-1.5";
  const tabBase = smallScreen
    ? "relative flex min-w-[3rem] flex-1 items-center justify-center whitespace-nowrap rounded-md px-1.5 py-1.5 text-[11px] transition-colors"
    : "relative flex min-w-[4.5rem] flex-1 items-center justify-center whitespace-nowrap rounded-lg px-3 py-2.5 text-sm transition-colors sm:min-w-[5.5rem]";
  const adminBase = smallScreen
    ? "relative shrink-0 rounded-md border px-2 py-1.5 text-[10px] font-medium transition-colors"
    : "relative shrink-0 rounded-lg border px-3 py-2.5 text-xs font-medium transition-colors sm:px-4";

  return (
    <nav
      className={`fixed bottom-0 left-0 right-0 z-40 flex items-stretch gap-1 border-t border-slate-800 bg-slate-900/95 px-2 shadow-[0_-4px_24px_rgba(0,0,0,0.35)] backdrop-blur-sm ${navPy} ${smallScreen ? "" : "sm:px-4"}`}
      role="tablist"
      aria-label="Workspace"
    >
      <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto">
        {ops.map((t) => {
          const selected = active === t.id;
          const displayLabel = smallScreen ? (t.shortLabel ?? t.label) : t.label;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={[
                tabBase,
                t.primary ? "font-semibold" : "font-medium",
                selected
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200",
              ].join(" ")}
              onClick={() => onSelect(t.id)}
            >
              {selected ? (
                <span
                  className={`absolute inset-x-1.5 top-0 rounded-full bg-sky-500 ${smallScreen ? "h-[2px]" : "h-0.5 inset-x-2"}`}
                  aria-hidden
                />
              ) : null}
              {displayLabel}
            </button>
          );
        })}
      </div>
      {admin ? (
        <button
          type="button"
          role="tab"
          aria-selected={active === "admin"}
          className={[
            adminBase,
            active === "admin"
              ? "border-violet-500/60 bg-violet-950/50 text-violet-200"
              : "border-slate-700 bg-slate-950/40 text-slate-500 hover:border-slate-600 hover:text-slate-300",
          ].join(" ")}
          onClick={() => onSelect(admin.id)}
        >
          {active === "admin" ? (
            <span
              className={`absolute inset-x-1.5 top-0 rounded-full bg-violet-400 ${smallScreen ? "h-[2px]" : "h-0.5 inset-x-2"}`}
              aria-hidden
            />
          ) : null}
          {smallScreen ? "⚙" : admin.label}
        </button>
      ) : null}
    </nav>
  );
}
