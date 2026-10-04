import { expect, test } from "@playwright/test";

// The npm packages in today's production bundle and the licence each declares. When the bundle changes, this test fails on
// purpose: check that the new package's licence is on the ADR-0017 allowlist, then update the list.
const bundled: ReadonlyArray<readonly [string, "MIT" | "Apache-2.0"]> = [
  ["clsx", "MIT"],
  ["react", "MIT"],
  ["react-aria", "Apache-2.0"],
  ["react-aria-components", "Apache-2.0"],
  ["react-dom", "MIT"],
  ["react-stately", "Apache-2.0"],
  ["scheduler", "MIT"],
];

// Wording that every copy of each licence contains.
const licenceWording = {
  MIT: "Permission is hereby granted, free of charge",
  "Apache-2.0": "Apache License",
} as const;

/** Splits the notices file into one section per package: the "## name - version (licence)" heading and the text below it. */
function sections(text: string): Map<string, { heading: string; body: string }> {
  const result = new Map<string, { heading: string; body: string }>();
  let current: { heading: string; body: string } | undefined;
  for (const line of text.split("\n")) {
    const heading = /^## (\S+) - \d\S* \(.+\)$/.exec(line);
    if (heading?.[1] !== undefined) {
      current = { heading: line, body: "" };
      result.set(heading[1], current);
    } else if (current !== undefined) {
      current.body += `${line}\n`;
    }
  }
  return result;
}

test("the licence notices name every bundled package along with its licence text", async ({ request }) => {
  const response = await request.get("/third-party-licenses.txt");
  expect(response.ok()).toBe(true);
  const found = sections(await response.text());

  expect([...found.keys()].sort()).toEqual(bundled.map(([name]) => name));
  for (const [name, licence] of bundled) {
    const section = found.get(name);
    expect(section?.heading, name).toContain(`(${licence})`);
    expect(section?.body, name).toContain(licenceWording[licence]);
  }
});
