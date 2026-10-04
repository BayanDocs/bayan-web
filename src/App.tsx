import { useEffect, useState } from "react";
import { safeLocalStorage } from "./storage.ts";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { applyTheme, readStoredTheme, resolveTheme, storeTheme, type Theme } from "./theme.ts";

function initialTheme(): Theme {
  const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return resolveTheme(readStoredTheme(safeLocalStorage()), systemPrefersDark);
}

/**
 * The application frame: a title bar, the ribbon region (generated from the shared UI manifest in a later work package, ADR-0019)
 * and the canvas region where engine-rendered pages will be drawn (WEB-002).
 */
export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

  const changeTheme = (next: Theme) => {
    setTheme(next);
    storeTheme(safeLocalStorage(), next);
  };

  return (
    <div className="app-frame">
      <header className="title-bar">
        <span className="title-bar__name">BayanDocs</span>
        <ThemeSwitch theme={theme} onChange={changeTheme} />
      </header>
      <section className="ribbon" aria-label="Ribbon" data-testid="ribbon">
        <p className="placeholder">Ribbon</p>
      </section>
      <main className="canvas-region" aria-label="Document" data-testid="canvas-region">
        <div className="page-placeholder" aria-hidden="true" />
      </main>
    </div>
  );
}
