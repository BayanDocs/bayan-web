import { defineConfig } from "vite";
import { devHeaders, productionHeaders } from "./config/security-headers.ts";

// Vite compiles TypeScript and JSX itself (with Oxc), so no React plugin is needed.
// The React plugin's only extra is Fast Refresh, which needs an inline script that our Content Security Policy forbids.
export default defineConfig({
  oxc: {
    jsx: { runtime: "automatic" },
  },
  server: {
    headers: devHeaders,
    // The error overlay builds its markup with innerHTML, which Trusted Types blocks; errors still appear in the terminal and the browser console.
    hmr: { overlay: false },
  },
  preview: {
    headers: productionHeaders,
  },
  build: {
    target: "es2024",
    // No source maps in production output: they would publish a second copy of the code with no benefit to users (source is linked from the app instead).
    sourcemap: false,
    // Vite's polyfill for <link rel="modulepreload"> is not needed by the browsers we support (PLT-02), so leave it out of the bundle.
    modulePreload: { polyfill: false },
    // Keep asset files separate (never inlined as data: URLs) so each gets its own integrity hash.
    assetsInlineLimit: 0,
    // Licence notices: MIT, Apache-2.0 and similar licences require them whenever the code is redistributed, and every page load
    // redistributes the bundle. Vite writes the name, version, SPDX identifier and full licence text of every npm package in the
    // bundle to this file; scripts/check-licenses.ts then checks it (the app links to it from the title bar).
    license: { fileName: "third-party-licenses.txt" },
  },
});
