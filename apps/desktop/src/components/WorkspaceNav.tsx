import dispenserIconRaw  from "@/assets/icons/dispenser.svg?raw";
import fuelVolumeIconRaw from "@/assets/icons/fuel-volume.svg?raw";
import historyIconRaw    from "@/assets/icons/history-table.svg?raw";
import settingIconRaw    from "@/assets/icons/setting.svg?raw";
import userIconRaw       from "@/assets/icons/user.svg?raw";

// Encode SVG as a base64 data URI so CSS mask-image works in WebView2 (Tauri/Windows)
function svgToDataUri(raw: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(raw)))}`;
}

const dispenserIcon  = svgToDataUri(dispenserIconRaw);
const fuelVolumeIcon = svgToDataUri(fuelVolumeIconRaw);
const historyIcon    = svgToDataUri(historyIconRaw);
const settingIcon    = svgToDataUri(settingIconRaw);
const userIcon       = svgToDataUri(userIconRaw);
import { ThemeToggleCompact } from "./ThemeToggle";
import { LanguageSwitcher } from "./LanguageSwitcher";

export type WorkspaceTabId =
  | "dispensers"
  | "shift"
  | "reservoirs"
  | "history"
  | "admin";

export type WorkspaceTabDef = {
  id: WorkspaceTabId;
  label: string;
  shortLabel?: string;
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
  shift:      userIcon,
  reservoirs: fuelVolumeIcon,
  history:    historyIcon,
  admin:      settingIcon,
};

/* Colour-masked SVG icon — adapts to any colour via CSS mask */
function NavIcon({ src, active }: { src: string; active: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-[20px] w-[20px] transition-colors ${
        active ? "bg-accent-emerald" : "bg-text-muted"
      }`}
      style={{
        WebkitMaskImage:    `url(${src})`,
        maskImage:          `url(${src})`,
        WebkitMaskRepeat:   "no-repeat",
        maskRepeat:         "no-repeat",
        WebkitMaskSize:     "contain",
        maskSize:           "contain",
        WebkitMaskPosition: "center",
        maskPosition:       "center",
      }}
    />
  );
}

/* ── Mobile bottom tab ──────────────────────────────────────────────────── */
function MobileTab({
  tab,
  selected,
  onSelect,
  compact,
}: {
  tab: WorkspaceTabDef;
  selected: boolean;
  onSelect: () => void;
  compact: boolean;
}) {
  const label = compact ? (tab.shortLabel ?? tab.label) : tab.label;
  const icon  = TAB_ICON_MAP[tab.id];

  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={tab.label}
      onClick={onSelect}
      className={[
        "group relative flex min-w-[2.75rem] flex-1 flex-col items-center",
        "gap-0.5 rounded-2xl px-1 py-1.5 transition-all",
        selected
          ? "bg-accent-emerald/10 text-accent-emerald"
          : "text-text-muted hover:text-text-secondary",
      ].join(" ")}
    >
      {/* Icon */}
      {icon && <NavIcon src={icon} active={selected} />}

      {/* Label */}
      <span
        className={[
          "max-w-full truncate text-[8px] font-bold uppercase leading-none tracking-wide",
          selected ? "text-accent-emerald" : "text-text-muted group-hover:text-text-secondary",
        ].join(" ")}
      >
        {label}
      </span>

      {/* Active indicator */}
      {selected && (
        <span className="absolute bottom-1 left-1/2 h-[3px] w-5 -translate-x-1/2 rounded-full bg-accent-emerald" />
      )}
    </button>
  );
}

/* ── Desktop side-rail button ───────────────────────────────────────────── */
function RailTab({
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
      className={[
        "group relative flex h-10 w-10 items-center justify-center rounded-xl transition-all",
        selected
          ? "bg-accent-emerald/15 text-accent-emerald"
          : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary",
      ].join(" ")}
    >
      {/* Left active stripe */}
      {selected && (
        <span className="absolute -left-px top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-emerald" />
      )}

      {icon && <NavIcon src={icon} active={selected} />}

      {/* Hover tooltip */}
      <span className="pointer-events-none absolute right-full mr-3 flex items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 z-50">
        <span className="whitespace-nowrap rounded-lg bg-[rgb(var(--color-text-primary))] px-2.5 py-1 text-xs font-semibold tracking-wide text-[rgb(var(--color-bg-primary))] shadow-lg">
          {tab.label}
        </span>
        <span className="h-0 w-0 border-y-[5px] border-l-[5px] border-y-transparent border-l-[rgb(var(--color-text-primary))]" />
      </span>
    </button>
  );
}

/* ── Public component ───────────────────────────────────────────────────── */
export function WorkspaceNav({
  tabs,
  active,
  onSelect,
  smallScreen = false,
  variant = "mobile",
}: WorkspaceNavProps) {
  /* Desktop side rail */
  if (variant === "desktop") {
    return (
      <nav
        role="tablist"
        aria-label="Workspace side rail"
        className="flex h-full flex-col items-center justify-between py-3"
      >
        <div className="flex flex-col items-center gap-1.5">
          {tabs.map((tab) => (
            <RailTab
              key={tab.id}
              tab={tab}
              selected={active === tab.id}
              onSelect={() => onSelect(tab.id)}
            />
          ))}
        </div>

        <div className="flex flex-col items-center gap-2 pb-1">
          <div className="h-px w-6 bg-border-primary/40" />
          <ThemeToggleCompact />
          <LanguageSwitcher />
        </div>
      </nav>
    );
  }

  /* Mobile floating tab bar */
  return (
    <nav
      role="tablist"
      aria-label="Workspace"
      className="pointer-events-none fixed inset-x-0 bottom-3 z-40 flex justify-center px-3"
    >
      <div className="pointer-events-auto flex w-full max-w-xl">
        <div
          className={[
            "flex w-full items-stretch gap-0.5",
            "rounded-[24px] border border-border-primary/70",
            "bg-bg-card/96 px-2 py-1",
            "shadow-[0_6px_24px_rgba(5,10,20,0.28)] backdrop-blur-xl",
          ].join(" ")}
        >
          {tabs.map((tab) => (
            <MobileTab
              key={tab.id}
              tab={tab}
              selected={active === tab.id}
              onSelect={() => onSelect(tab.id)}
              compact={smallScreen}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}
