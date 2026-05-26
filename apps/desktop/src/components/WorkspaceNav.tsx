import dispenserIcon from "@/assets/icons/dispenser.svg";
import fuelVolumeIcon from "@/assets/icons/fuel-volume.svg";
import historyIcon from "@/assets/icons/history-table.svg";
import globeIcon from "@/assets/icons/globe.svg";
import settingIcon from "@/assets/icons/setting.svg";
import userIcon from "@/assets/icons/user.svg";

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
  variant?: "mobile" | "desktop";
};

const TAB_ICON_MAP: Record<WorkspaceTabId, string> = {
  dispensers: dispenserIcon,
  shift: userIcon,
  reservoirs: fuelVolumeIcon,
  history: historyIcon,
  today: globeIcon,
  admin: settingIcon,
};

function NavIcon({ src, tone }: { src: string; tone: "active" | "idle" }) {
  const colorClass = tone === "active" ? "bg-accent-emerald" : "bg-text-tertiary";
  return (
    <span
      className={`inline-block h-[18px] w-[18px] ${colorClass}`}
      aria-hidden
      style={{
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}

function HorizontalTabButton({
  tab,
  selected,
  onSelect,
  smallScreen,
}: {
  tab: WorkspaceTabDef;
  selected: boolean;
  onSelect: () => void;
  smallScreen: boolean;
}) {
  const displayLabel = smallScreen ? tab.shortLabel ?? tab.label : tab.label;
  const icon = TAB_ICON_MAP[tab.id];
  const buttonBase = smallScreen
    ? "min-w-[3.25rem]"
    : "min-w-[3.75rem]";

  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={tab.label}
      onClick={onSelect}
      className={`group relative flex flex-col items-center gap-1 rounded-2xl px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide transition ${
        selected ? "text-text-primary" : "text-text-tertiary hover:text-text-secondary"
      } ${buttonBase}`}
    >
      <span
        className={`flex h-9 w-9 items-center justify-center rounded-full border bg-bg-primary transition-all ${
          selected
            ? "border-accent-emerald text-accent-emerald"
            : "border-border-primary/70 text-text-tertiary group-hover:border-border-primary"
        }`}
      >
        {icon ? <NavIcon src={icon} tone={selected ? "active" : "idle"} /> : <span>{displayLabel?.[0]}</span>}
      </span>
      <span className="max-w-[4.5rem] truncate text-[9px] font-bold tracking-wide">
        {displayLabel}
      </span>
    </button>
  );
}

function SideRailButton({
  tab,
  selected,
  onSelect,
}: {
  tab: WorkspaceTabDef;
  selected: boolean;
  onSelect: () => void;
}) {
  const icon = TAB_ICON_MAP[tab.id];
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={tab.label}
      onClick={onSelect}
      className={`group relative flex h-10 w-10 items-center justify-center rounded-xl transition-all ${
        selected
          ? "bg-accent-emerald/15 text-accent-emerald shadow-inner"
          : "text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
      }`}
    >
      {icon ? <NavIcon src={icon} tone={selected ? "active" : "idle"} /> : <span className="font-bold text-sm">{tab.label[0]}</span>}
      
      {/* Tooltip */}
      <div className="absolute right-full mr-3 pointer-events-none flex items-center opacity-0 transition-opacity duration-200 group-hover:opacity-100 z-50">
        <span className="whitespace-nowrap rounded-lg bg-[rgb(var(--color-text-primary))] px-2.5 py-1 text-xs font-semibold tracking-wide text-[rgb(var(--color-bg-primary))] shadow-lg">
          {tab.label}
        </span>
        <div className="h-0 w-0 border-y-[5px] border-l-[5px] border-y-transparent border-l-[rgb(var(--color-text-primary))]" />
      </div>
    </button>
  );
}

export function WorkspaceNav({
  tabs,
  active,
  onSelect,
  smallScreen = false,
  variant = "mobile",
}: WorkspaceNavProps) {
  if (variant === "desktop") {
    return (
      <nav 
        role="tablist" 
        aria-label="Workspace side rail" 
        className="flex flex-col items-center gap-2 bg-transparent py-2"
      >
        {tabs.map((tab) => (
          <SideRailButton
            key={tab.id}
            tab={tab}
            selected={active === tab.id}
            onSelect={() => onSelect(tab.id)}
          />
        ))}
      </nav>
    );
  }

  return (
    <nav
      className="pointer-events-none fixed inset-x-0 bottom-3 z-40 flex justify-center px-3 sm:px-4"
      role="tablist"
      aria-label="Workspace"
    >
      <div className="pointer-events-auto flex w-full max-w-5xl justify-center">
        <div className="flex w-full items-center justify-center gap-1 overflow-x-auto rounded-[32px] border border-border-primary/70 bg-bg-primary/95 px-2.5 py-1.5 shadow-[0_12px_24px_rgba(5,10,20,0.35)] backdrop-blur-xl">
          {tabs.map((tab) => (
            <HorizontalTabButton
              key={tab.id}
              tab={tab}
              selected={active === tab.id}
              onSelect={() => onSelect(tab.id)}
              smallScreen={smallScreen}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}
