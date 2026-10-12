// The app's only Trusted Types policy, bayan-script-url (WEB-002 AC-5).
//
// Under the Content Security Policy's `require-trusted-types-for 'script'`, new Worker() accepts only a TrustedScriptURL, which only a
// named policy can create, and `trusted-types bayan-script-url` (config/security-headers.ts) lets exactly one policy of that name exist.
// This module creates it, the first time a worker is started, and is the only place in src/ that may (tests/unit/trusted-types.test.ts
// fails otherwise). The policy implements createScriptURL only, so it can never produce HTML or script text, and it accepts nothing but
// the same-origin paths of the app's own worker scripts, which the build writes into the app (virtual:bayan-engine).

import { engineFiles } from "virtual:bayan-engine";
import { allowedScriptUrl, isPlainPath } from "./script-url.ts";

export const policyName = "bayan-script-url";

/** The scripts the app may start as workers: the engine's worker host. The PWA's service worker will join it (ADR-0014 §10). */
const workerScripts: ReadonlySet<string> = new Set([engineFiles.worker.url].filter(isPlainPath));

/** The opaque value new Worker() accepts under Trusted Types. */
export interface TrustedScriptURL {
  readonly __brand: "TrustedScriptURL";
}

interface ScriptUrlPolicy {
  createScriptURL(input: string): TrustedScriptURL;
}

interface PolicyFactory {
  createPolicy(name: string, rules: { createScriptURL(input: string): string }): ScriptUrlPolicy;
}

let policy: ScriptUrlPolicy | undefined;

/**
 * The address of one of the app's worker scripts, as new Worker() accepts it: a TrustedScriptURL from the bayan-script-url policy.
 * Throws a TypeError for any other address. In a browser without Trusted Types (none of those the app supports, PLT-02), it applies the
 * same check and returns the checked string.
 */
export function workerScriptUrl(path: string): TrustedScriptURL | string {
  const factory = (globalThis as { trustedTypes?: PolicyFactory }).trustedTypes;
  if (factory === undefined) {
    return allowedScriptUrl(path, workerScripts);
  }
  policy ??= factory.createPolicy(policyName, {
    createScriptURL: (input) => allowedScriptUrl(input, workerScripts),
  });
  return policy.createScriptURL(path);
}
