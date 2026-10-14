// Screen-reader evidence for WEB-002 (AC-3 and the caret-sync prototype): opens the built app in a visible browser while Orca runs
// (tests/screen-reader/start-orca.sh), presses keys and clicks the way a person does, through the X server with xdotool so that Orca
// notices them, and writes what Orca spoke, step by step, from Orca's debug log. Three scenarios:
//   1. reading: Orca's browse mode moves through the accessibility mirror by heading, line, list and table;
//   2. editing after Tab: focus reaches the editable line by keyboard, Orca switches to focus mode, typed characters are echoed and the
//      characters the caret moves over are read, from the input bridge's text and caret (which the engine sets);
//   3. editing after a click: the same after a real mouse click on the page.
// Not part of `pnpm verify`: it needs a desktop session's accessibility stack, which start-orca.sh provides on Ubuntu 24.04.
//
// Usage: (with `pnpm preview` serving a build on port 4173, and start-orca.sh's env.sh sourced)
//   node tests/screen-reader/orca.ts <firefox|chromium> <orca-output-folder> [<evidence-file>]
// Chromium must be a full build, not Playwright's headless shell: set CHROMIUM_EXECUTABLE to one.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, firefox, type Page } from "@playwright/test";

const [browserName, orcaFolder, evidenceFile] = process.argv.slice(2);
if ((browserName !== "firefox" && browserName !== "chromium") || orcaFolder === undefined) {
  throw new Error("usage: node tests/screen-reader/orca.ts <firefox|chromium> <orca-output-folder> [<evidence-file>]");
}
const url = process.env["BAYAN_URL"] ?? "http://127.0.0.1:4173/";
const log = join(orcaFolder, "orca-debug.log");
const steps: string[] = [];

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
/** Local time as Orca writes it in its log, HH:MM:SS.mmm. */
const clock = () => {
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, "0")}`;
};
const step = (text: string) => steps.push(`${clock()} STEP ${text}`);

async function keys(...names: string[]): Promise<void> {
  for (const name of names) {
    execFileSync("xdotool", ["key", "--clearmodifiers", name]);
    await pause(1300);
  }
}

async function type(text: string): Promise<void> {
  execFileSync("xdotool", ["type", "--delay", "500", text]);
  await pause(2000);
}

async function launch(): Promise<Browser> {
  // Both browsers expose their accessibility tree over AT-SPI when an assistive technology is running; these make sure they do.
  const env = { ...process.env, GNOME_ACCESSIBILITY: "1", ACCESSIBILITY_ENABLED: "1" } as Record<string, string>;
  if (browserName === "firefox") return firefox.launch({ headless: false, env });
  const executablePath = process.env["CHROMIUM_EXECUTABLE"];
  return chromium.launch({
    headless: false,
    env,
    args: ["--force-renderer-accessibility"],
    ...(executablePath === undefined ? {} : { executablePath }),
  });
}

async function open(browser: Browser): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(url);
  await page.locator('.document-view[data-engine-state="ready"]').waitFor();
  await pause(3000);
  return page;
}

async function editableText(page: Page): Promise<string> {
  return page
    .locator(".input-bridge")
    .evaluate((element) => (element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? "")));
}

const browser = await launch();
const start = clock();

step("scenario 1: reading the mirror in browse mode");
let page = await open(browser);
step("h: next heading");
await keys("h");
step("Down x3: the next lines");
await keys("Down", "Down", "Down");
step("h: next heading");
await keys("h");
step("l: next list");
await keys("l");
step("Down x2");
await keys("Down", "Down");
step("t: next table");
await keys("t");
step("Down x3");
await keys("Down", "Down", "Down");
await page.close();

step("scenario 2: Tab to the editable line, type, move the caret");
page = await open(browser);
await page.getByRole("button", { name: "Zoom in" }).focus();
await pause(1500);
step("Tab, Tab: the Pages region, then the editable line");
await keys("Tab", "Tab");
step("type 'Hi'");
await type("Hi");
step("Left: the caret moves before 'i'");
await keys("Left");
step("Left: the caret moves before 'H'");
await keys("Left");
step("Right: the caret moves after 'H'");
await keys("Right");
step("BackSpace: deletes 'H'");
await keys("BackSpace");
step(`the engine's editable text is now ${JSON.stringify(await editableText(page))}`);
await page.close();

step("scenario 3: a mouse click on the page, then type");
page = await open(browser);
const box = await page.getByTestId("document-scroller").boundingBox();
const origin = await page.evaluate(() => {
  const firefoxWindow = window as unknown as { mozInnerScreenX?: number; mozInnerScreenY?: number };
  return {
    x: firefoxWindow.mozInnerScreenX ?? window.screenX,
    y: firefoxWindow.mozInnerScreenY ?? window.screenY + window.outerHeight - window.innerHeight,
  };
});
const x = Math.round(origin.x + (box?.x ?? 0) + (box?.width ?? 0) / 2);
const y = Math.round(origin.y + (box?.y ?? 0) + 80);
step("click on the first page");
execFileSync("xdotool", ["mousemove", String(x), String(y), "click", "1"]);
await pause(2000);
step("type 'ok'");
await type("ok");
step(`the engine's editable text is now ${JSON.stringify(await editableText(page))}`);
await browser.close();

// Orca's lines are "HH:MM:SS.micro - SPEECH OUTPUT: 'text' {voice}"; keep what it spoke since this run started, without the voice.
const spoken = readFileSync(log, "utf8")
  .split("\n")
  .map((line) => /^(\d\d:\d\d:\d\d\.\d{3})\d* - SPEECH OUTPUT: (.*?)(?: \{'established'.*)?$/.exec(line))
  .filter((match): match is RegExpExecArray => match !== null && (match[1] ?? "") >= start)
  .map((match) => `${match[1]} ORCA ${match[2]}`);
const evidence = [...steps, ...spoken].sort().join("\n");
const header = `# Orca ${browserName} evidence for WEB-002, ${new Date().toISOString()} (${url})\n`;
if (evidenceFile === undefined) console.log(header + evidence);
else writeFileSync(evidenceFile, `${header}${evidence}\n`);
