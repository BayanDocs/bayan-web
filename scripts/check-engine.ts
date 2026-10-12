// Checks that engine-package/ holds the engine's WebAssembly package built from the bayan-core commit pinned in bayan-core.pin, with
// every file the app serves (config/engine-files.ts). The first step of `pnpm verify` after the dependency checks, so that nothing is
// type-checked, built or tested against another engine than the pinned one.
//
// Usage: node scripts/check-engine.ts   (run from the repository root; build the package with scripts/engine-package.sh)

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPackageDir, parsePin, pinFile, protocolDeclarations, readEngineBuild } from "../config/engine-files.ts";

/** Returns the problems with the engine package; an empty list means it matches the pin. */
export function checkEngine(packageDir: string, pinText: string): string[] {
  const pinned = parsePin(pinText, "bayan-core.pin");
  let build: ReturnType<typeof readEngineBuild>;
  try {
    build = readEngineBuild(packageDir);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const problems: string[] = [];
  if (build.commit !== pinned) {
    problems.push(
      `${packageDir} was built from bayan-core ${build.commit}, but bayan-core.pin names ${pinned}; run scripts/engine-package.sh.`,
    );
  }
  if (!existsSync(join(packageDir, protocolDeclarations))) {
    problems.push(`${join(packageDir, protocolDeclarations)} is missing; the app's protocol types come from it.`);
  }
  return problems;
}

function main(): void {
  const problems = checkEngine(defaultPackageDir, readFileSync(pinFile, "utf8"));
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  const build = readEngineBuild(defaultPackageDir);
  console.log(
    `Engine: the WebAssembly package of engine ${build.version}, built from bayan-core ${build.commit} (bayan-core.pin).`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Engine check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
