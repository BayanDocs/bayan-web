import type { Page } from "@playwright/test";

/**
 * Records everything that would mean the page is not working as built: Content Security Policy and Trusted Types violations,
 * console errors and uncaught exceptions. Call before navigating.
 */
export async function collectProblems(page: Page): Promise<() => Promise<string[]>> {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`uncaught exception: ${error.message}`));
  // The securitypolicyviolation event fires for every blocked script, style, Trusted Types sink and so on.
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, "__cspViolations", { value: seen });
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(
        `${event.effectiveDirective} blocked ${event.blockedURI || "(inline)"} at ${event.sourceFile}:${event.lineNumber}`,
      );
    });
  });
  return async () => {
    const violations = await page.evaluate(
      () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
    );
    return [...problems, ...violations.map((v) => `CSP violation: ${v}`)];
  };
}
