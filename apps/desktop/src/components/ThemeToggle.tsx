import { Sun, Moon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTheme } from "../contexts/ThemeContext";

interface ThemeToggleProps {
  variant?: "icon" | "button" | "switch";
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function ThemeToggle({
  variant = "icon",
  size = "md",
  className = "",
}: ThemeToggleProps) {
  const { theme, toggleTheme, isDark } = useTheme();
  const { t } = useTranslation();

  const sizeClasses = {
    sm: "p-1.5",
    md: "p-2",
    lg: "p-3",
  };

  const iconSizes = {
    sm: "h-4 w-4",
    md: "h-5 w-5",
    lg: "h-6 w-6",
  };

  if (variant === "switch") {
    return (
      <button
        onClick={toggleTheme}
        className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent-amber focus:ring-offset-2 focus:ring-offset-bg-primary ${
          isDark ? "bg-bg-tertiary" : "bg-accent-amber"
        } ${className}`}
        aria-label={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
        title={isDark ? t("theme.dark") : t("theme.light")}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-text-primary shadow-lg transition-transform ${
            isDark ? "translate-x-1.5" : "translate-x-6"
          }`}
        >
          {isDark ? (
            <Moon className="h-3 w-3 text-text-inverse m-auto mt-0.5" />
          ) : (
            <Sun className="h-3 w-3 text-accent-amber m-auto mt-0.5" />
          )}
        </span>
      </button>
    );
  }

  if (variant === "button") {
    return (
      <button
        onClick={toggleTheme}
        className={`inline-flex items-center gap-2 rounded-md border-2 border-border-primary bg-bg-secondary px-3 py-2 text-sm font-semibold text-text-secondary transition-all hover:bg-bg-tertiary hover:text-text-primary hover:shadow-button-hover active:scale-95 ${className}`}
        aria-label={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
        title={isDark ? t("theme.dark") : t("theme.light")}
      >
        {isDark ? (
          <>
            <Sun className={iconSizes[size]} />
            <span>{t("theme.switchToLight")}</span>
          </>
        ) : (
          <>
            <Moon className={iconSizes[size]} />
            <span>{t("theme.switchToDark")}</span>
          </>
        )}
      </button>
    );
  }

  // Icon variant (default)
  return (
    <button
      onClick={toggleTheme}
      className={`rounded-md border-2 border-border-primary bg-bg-secondary text-text-secondary transition-all hover:bg-bg-tertiary hover:text-text-primary hover:shadow-button-hover focus:outline-none focus:ring-2 focus:ring-accent-amber focus:ring-offset-2 focus:ring-offset-bg-primary active:scale-95 ${sizeClasses[size]} ${className}`}
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      title={`Current theme: ${theme}`}
    >
      {isDark ? (
        <Sun className={`${iconSizes[size]} text-accent-amber`} />
      ) : (
        <Moon className={`${iconSizes[size]} text-accent-blue`} />
      )}
    </button>
  );
}

// Compact version for toolbar/header usage
export function ThemeToggleCompact({ className = "" }: { className?: string }) {
  const { toggleTheme, isDark } = useTheme();
  const { t } = useTranslation();

  return (
    <button
      onClick={toggleTheme}
      className={`rounded-md border border-border-primary bg-bg-secondary p-1.5 text-text-secondary transition-all hover:bg-bg-tertiary hover:text-text-primary hover:border-border-focus ${className}`}
      aria-label={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
      title={isDark ? t("theme.dark") : t("theme.light")}
    >
      {isDark ? (
        <Sun className="h-4 w-4 text-accent-amber" />
      ) : (
        <Moon className="h-4 w-4 text-accent-blue" />
      )}
    </button>
  );
}
