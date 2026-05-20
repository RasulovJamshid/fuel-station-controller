/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Background colors
        "bg-primary": "rgb(var(--color-bg-primary))",
        "bg-secondary": "rgb(var(--color-bg-secondary))",
        "bg-tertiary": "rgb(var(--color-bg-tertiary))",
        "bg-card": "rgb(var(--color-bg-card))",
        "bg-header": "rgb(var(--color-bg-header))",
        "bg-meter": "rgb(var(--color-bg-meter))",
        "bg-input": "rgb(var(--color-bg-input))",

        // Text colors
        "text-primary": "rgb(var(--color-text-primary))",
        "text-secondary": "rgb(var(--color-text-secondary))",
        "text-tertiary": "rgb(var(--color-text-tertiary))",
        "text-muted": "rgb(var(--color-text-muted))",
        "text-inverse": "rgb(var(--color-text-inverse))",

        // Border colors
        "border-primary": "rgb(var(--color-border-primary))",
        "border-secondary": "rgb(var(--color-border-secondary))",
        "border-focus": "rgb(var(--color-border-focus))",

        // Accent colors - Emerald
        "accent-emerald": "rgb(var(--color-accent-emerald))",
        "accent-emerald-light": "rgb(var(--color-accent-emerald-light))",
        "accent-emerald-dark": "rgb(var(--color-accent-emerald-dark))",

        // Accent colors - Amber
        "accent-amber": "rgb(var(--color-accent-amber))",
        "accent-amber-light": "rgb(var(--color-accent-amber-light))",
        "accent-amber-dark": "rgb(var(--color-accent-amber-dark))",

        // Accent colors - Blue
        "accent-blue": "rgb(var(--color-accent-blue))",

        // Accent colors - Red
        "accent-red": "rgb(var(--color-accent-red))",
        "accent-red-light": "rgb(var(--color-accent-red-light))",
        "accent-red-dark": "rgb(var(--color-accent-red-dark))",

        // Status colors
        "status-delivering": "rgb(var(--color-status-delivering))",
        "status-preauth": "rgb(var(--color-status-preauth))",
        "status-idle": "rgb(var(--color-status-idle))",
        "status-offline": "rgb(var(--color-status-offline))",
        "status-error": "rgb(var(--color-status-error))",

        border: "rgb(var(--color-border-primary))",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        "card-hover": "var(--shadow-card-hover)",
        button: "var(--shadow-button)",
        "button-hover": "var(--shadow-button-hover)",
      },
    },
  },
  plugins: [],
};
