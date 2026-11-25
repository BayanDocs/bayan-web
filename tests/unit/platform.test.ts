import { describe, expect, it } from "vitest";
import { initMessage } from "../../src/engine/engine-manifest.ts";
import { browserPlatform } from "../../src/engine/platform.ts";

// The platform that hello names (engine protocol §14.1 item 2, src/engine/platform.ts), from what each browser reports: Chromium's
// navigator.userAgentData.platform where it exists, navigator.platform otherwise, and "other" when neither names a system on the list.

describe("the platform hello names", () => {
  it("takes Chromium's client hint for every system it reports", () => {
    const hints: [string, string][] = [
      ["Windows", "windows"],
      ["macOS", "macos"],
      ["Linux", "linux"],
      ["Android", "android"],
      ["Chrome OS", "chromeos"],
      ["Chromium OS", "chromeos"],
      ["iOS", "ios"],
    ];
    for (const [hint, platform] of hints) {
      // The client hint wins over navigator.platform, which Chromium on Android, for example, reports as Linux.
      expect(browserPlatform({ userAgentData: { platform: hint }, platform: "Linux armv8l" }), hint).toBe(platform);
    }
  });

  it("falls back to navigator.platform in Firefox and Safari, and where the hint names nothing on the list", () => {
    const platforms: [string, string][] = [
      ["Win32", "windows"],
      ["Win64", "windows"],
      ["MacIntel", "macos"],
      ["iPhone", "ios"],
      ["iPad", "ios"],
      ["iPod touch", "ios"],
      ["Linux x86_64", "linux"],
      ["Linux aarch64", "linux"],
      ["CrOS x86_64", "chromeos"],
      ["Android", "android"],
    ];
    for (const [value, platform] of platforms) {
      expect(browserPlatform({ platform: value }), value).toBe(platform);
      expect(browserPlatform({ userAgentData: { platform: "Unknown" }, platform: value }), value).toBe(platform);
      expect(browserPlatform({ userAgentData: { platform: "" }, platform: value }), value).toBe(platform);
    }
  });

  it("says other when neither source names a system, with which Ctrl stays Ctrl", () => {
    expect(browserPlatform({})).toBe("other");
    expect(browserPlatform({ platform: "" })).toBe("other");
    expect(browserPlatform({ platform: "FreeBSD amd64" })).toBe("other");
    expect(browserPlatform({ userAgentData: { platform: "Fuchsia" }, platform: 7 })).toBe("other");
    expect(browserPlatform({ userAgentData: undefined, platform: undefined })).toBe("other");
    // A value inherited from Object.prototype is no platform.
    expect(browserPlatform({ userAgentData: { platform: "constructor" } })).toBe("other");
  });
});

describe("the worker host's init message (spec §3.2, §14.8)", () => {
  it("names the module and its hash from the build's manifest", () => {
    const wasm = { url: "/assets/engine-0123456789abcdef/bayan_wasm_bg.wasm", integrity: "sha384-abc+/=" };
    expect(initMessage(wasm)).toEqual({
      worker: "init",
      wasm_url: "/assets/engine-0123456789abcdef/bayan_wasm_bg.wasm",
      wasm_integrity: "sha384-abc+/=",
    });
  });
});
