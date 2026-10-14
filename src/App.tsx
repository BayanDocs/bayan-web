import { engineFiles } from "virtual:bayan-engine";
import { useEffect, useState } from "react";
import { DocumentView } from "./DocumentView.tsx";
import { safeLocalStorage } from "./storage.ts";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { applyTheme, readStoredTheme, resolveTheme, storeTheme, type Theme } from "./theme.ts";

function initialTheme(): Theme {
  const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return resolveTheme(readStoredTheme(safeLocalStorage()), systemPrefersDark);
}

/**
 * The application frame: a title bar, the ribbon region (generated from the shared UI manifest in a later work package, ADR-0019)
 * and the document region, where the engine's pages are drawn (WEB-002).
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
        <div className="title-bar__actions">
          {/* The licence notices of the bundled third-party packages, written by the build (vite.config.ts, build.license). */}
          <a className="title-bar__link" href="/third-party-licenses.txt">
            Licenses
          </a>
          {/* The notices of the Rust code compiled into the engine, from its WebAssembly package (config/engine-files.ts). */}
          <a className="title-bar__link" href={engineFiles.notices.url}>
            Engine licenses
          </a>
          <ThemeSwitch theme={theme} onChange={changeTheme} />
        </div>
      </header>
      <section className="ribbon" aria-label="Ribbon" data-testid="ribbon">
        <p className="placeholder">Ribbon</p>
      </section>
      <main className="canvas-region" aria-label="Document" data-testid="canvas-region">
        <DocumentView />
      </main>
    </div>
  );
}
