import { useEffect, useState } from "react";

/**
 * The console's color theme. The palette lives in CSS custom properties
 * (styles.css) written with `light-dark()`, so with no choice the page follows
 * the system (`prefers-color-scheme`). A choice sets `data-theme` on the root
 * element and is remembered in localStorage (guarded: storage can be blocked).
 * `?theme=light` or `?theme=dark` in the address forces a theme for that view
 * without remembering it (handy for screenshots and shared links).
 */

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "switchyard-console-theme";

function isChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/** The theme a URL forces (`?theme=light|dark`), if any. */
export function themeFromSearch(search: string): "light" | "dark" | null {
  const value = new URLSearchParams(search).get("theme");
  return value === "light" || value === "dark" ? value : null;
}

export function readStoredTheme(storage: Pick<Storage, "getItem"> | undefined): ThemeChoice {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isChoice(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function storeTheme(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, choice: ThemeChoice): void {
  try {
    if (choice === "system") storage?.removeItem(THEME_STORAGE_KEY);
    else storage?.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage blocked (private mode, a sandboxed frame): the choice lasts for this page only.
  }
}

/** The next choice in the toggle's cycle: system -> light -> dark -> system. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return choice === "system" ? "light" : choice === "light" ? "dark" : "system";
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Apply a choice to the root element (`system` removes the attribute: the CSS follows the OS). */
export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

/** The theme to start with: a URL override, else the remembered choice, else the system's. */
export function initialTheme(): ThemeChoice {
  const forced = typeof window === "undefined" ? null : themeFromSearch(window.location.search);
  return forced ?? readStoredTheme(safeStorage());
}

/** A small button that cycles the theme and remembers the choice. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => initialTheme());
  useEffect(() => applyTheme(choice), [choice]);
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Color theme: ${choice}. Click to change.`}
      title="Color theme: system (follows your OS), light, or dark"
      onClick={() => {
        const next = nextTheme(choice);
        storeTheme(safeStorage(), next);
        setChoice(next);
      }}
    >
      theme: {choice}
    </button>
  );
}
