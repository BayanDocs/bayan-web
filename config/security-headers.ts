// The HTTP security headers every bayan-web server sends (ADR-0014 §9, requirement SEC-10).
// The Vite dev and preview servers use these objects directly; deploy/nginx.conf repeats them for production, and a unit test keeps the two in sync.

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
  // Trusted Types: string-to-code sinks such as innerHTML and script URLs accept only typed values, and 'none' means no policy
  // may exist to create them. As a result, new Worker(), trustedTypes.createPolicy() and navigator.serviceWorker.register() all
  // throw a TypeError in Chromium, Firefox and WebKit. Nothing in WEB-001 needs a policy, so 'none' stays for now.
  // WEB-002's amended AC-5 (BayanDocs/docs: workpackages/phase-0/WEB-002-spike-worker-canvas.md) permits exactly one named
  // policy, bayan-script-url, to start the engine worker; any other policy needs an approved work package.
  ["require-trusted-types-for", "'script'"],
  ["trusted-types", "'none'"],
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
