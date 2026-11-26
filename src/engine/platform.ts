// The platform this shell names in hello (engine protocol §14.1 item 2): the operating system whose keyboard conventions apply, from the
// protocol's fixed list, as far as the browser tells it. The engine uses it only to resolve the UI manifest's key bindings (§14.3), such as
// Command in place of Ctrl on macOS; nothing that affects layout or rendering depends on it (ADR-0004).
//
// Chromium tells the system through navigator.userAgentData.platform (User-Agent Client Hints); Firefox and Safari have only
// navigator.platform, which is deprecated but present everywhere. Neither is a security boundary: a wrong platform only changes which keys
// are bound. When neither names a system this list knows, the platform is "other", with which Ctrl stays Ctrl.

import type { Platform } from "./protocol.ts";

/** The parts of `navigator` that tell the platform. userAgentData is not in TypeScript's DOM types, because only Chromium has it. */
export interface PlatformSources {
  readonly userAgentData?: { readonly platform?: unknown } | undefined;
  readonly platform?: unknown;
}

/** navigator.userAgentData.platform's values (the Sec-CH-UA-Platform header's), by the platform each names. */
const clientHints: Readonly<Record<string, Platform>> = {
  Windows: "windows",
  macOS: "macos",
  Linux: "linux",
  Android: "android",
  iOS: "ios",
  "Chrome OS": "chromeos",
  "Chromium OS": "chromeos",
};

/** navigator.platform's values, by how they start: such as "Win32", "MacIntel", "iPhone", "CrOS x86_64" and "Linux x86_64". */
const platformPrefixes: readonly (readonly [string, Platform])[] = [
  ["Win", "windows"],
  ["Mac", "macos"],
  ["iPhone", "ios"],
  ["iPad", "ios"],
  ["iPod", "ios"],
  ["Android", "android"],
  ["CrOS", "chromeos"],
  ["Linux", "linux"],
];

/** The platform that `navigator` names: userAgentData.platform where the browser has it, navigator.platform otherwise, else "other". */
export function browserPlatform(sources: PlatformSources): Platform {
  const hint = sources.userAgentData?.platform;
  if (typeof hint === "string" && Object.hasOwn(clientHints, hint)) return clientHints[hint] as Platform;
  const platform = sources.platform;
  if (typeof platform === "string") {
    for (const [prefix, name] of platformPrefixes) {
      if (platform.startsWith(prefix)) return name;
    }
  }
  return "other";
}
