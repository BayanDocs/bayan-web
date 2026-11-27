// The HTTP security headers every bayan-web server sends (ADR-0014 §9, requirement SEC-10).
// The Vite dev and preview servers use these objects directly; deploy/nginx/security-headers.conf repeats them for production, and a unit test keeps the two in sync.
// bayan-server, which serves the web app by default (ADR-0015 decision 2), sends the production set from a copy of its own,
// crates/bayan-server/src/http/headers.rs, and its tests/http.rs compares what the server sends with a copy of this set taken by hand from
// a named bayan-web commit. Nothing compares either copy with this file, so a change here alone passes the checks of both repositories while
// the server keeps sending the old set (the architecture review of 2026-11-20, M13): every change to these headers needs a paired
// bayan-server pull request that changes headers.rs, the test's copy and the bayan-web commit it names together, until WEB-103 with SRV-105
// makes the web app's build the single source of the headers.

/** Content Security Policy directives, in the order they are written to the header. */
export const cspDirectives: ReadonlyArray<readonly [string, ...string[]]> = [
  // Everything comes from our own origin: no CDNs, no third-party origins, no analytics.
  ["default-src", "'self'"],
  // Scripts only from our origin, never inline, never eval. 'wasm-unsafe-eval' allows compiling WebAssembly (the engine) and nothing else.
  ["script-src", "'self'", "'wasm-unsafe-eval'"],
  ["style-src", "'self'"],
  // blob: lets the canvas and worker hand engine-rendered images to <img> elements later on.
  ["img-src", "'self'", "blob:"],
  ["font-src", "'self'"],
  ["connect-src", "'self'"],
  ["worker-src", "'self'"],
  ["manifest-src", "'self'"],
  ["object-src", "'none'"],
  ["base-uri", "'none'"],
  ["form-action", "'none'"],
  ["frame-src", "'none'"],
  ["frame-ancestors", "'none'"],
  // Trusted Types: string-to-code sinks such as innerHTML and script URLs accept only typed values, created by a named policy.
  // Exactly one policy may exist: bayan-script-url, which turns the address of the engine's worker script into the TrustedScriptURL
  // that new Worker() requires, and refuses every other address (src/security/script-url-policy.ts; WEB-002 AC-5 in BayanDocs/docs:
  // workpackages/phase-0/WEB-002-spike-worker-canvas.md). Without 'allow-duplicates' a second policy of that name cannot be created,
  // so nothing else can obtain one. WEB-001 had 'none' here; any further policy needs an amendment of ADR-0014 (BayanDocs/docs:
  // adr/0014-web-shell.md, amendment of 2026-10-12, design detail 1), not only an approved work package.
  ["require-trusted-types-for", "'script'"],
  ["trusted-types", "bayan-script-url"],
];

/** Serializes CSP directives into a header value. */
export function serializeCsp(directives: ReadonlyArray<readonly [string, ...string[]]>): string {
  return directives.map((d) => d.join(" ")).join("; ");
}

const baseHeaders: Readonly<Record<string, string>> = {
  "Content-Security-Policy": serializeCsp(cspDirectives),
  // Cross-origin isolation: required for SharedArrayBuffer (WebAssembly threads, ADR-0014 §8) and keeps other sites' windows and resources out of our process.
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()",
};

/**
 * Headers for built output (the preview server and production).
 * Integrity-Policy makes the browser refuse any script that lacks a Subresource Integrity hash; scripts/sri.ts adds the hashes after `vite build`.
 */
export const productionHeaders: Readonly<Record<string, string>> = {
  ...baseHeaders,
  "Integrity-Policy": "blocked-destinations=(script)",
};

/**
 * Headers for the development server: the same, except Integrity-Policy, because the dev server serves untransformed source modules that cannot carry integrity hashes.
 */
export const devHeaders: Readonly<Record<string, string>> = { ...baseHeaders };
