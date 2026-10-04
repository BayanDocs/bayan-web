// Light and dark themes. The theme follows the operating system until the user picks one; the choice is remembered in this browser only.

export type Theme = "light" | "dark";

const storageKey = "bayandocs.theme";

/** Returns the stored theme, or null if nothing valid is stored. Stored values are untrusted input. */
export function parseTheme(value: unknown): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

/** The theme to show: the user's choice if there is one, otherwise the system preference. */
export function resolveTheme(stored: Theme | null, systemPrefersDark: boolean): Theme {
  return stored ?? (systemPrefersDark ? "dark" : "light");
}

export function readStoredTheme(storage: Pick<Storage, "getItem"> | undefined): Theme | null {
  try {
    return parseTheme(storage?.getItem(storageKey));
  } catch {
    // Storage can be unavailable (private browsing, blocked site data); fall back to the system theme.
    return null;
  }
}

export function storeTheme(storage: Pick<Storage, "setItem"> | undefined, theme: Theme): void {
  try {
    storage?.setItem(storageKey, theme);
  } catch {
    // Not remembering the choice is acceptable.
  }
}

/** Applies a theme to the document; styles.css reads the data-theme attribute. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.dataset["theme"] = theme;
}
