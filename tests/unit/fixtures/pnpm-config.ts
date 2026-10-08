/** What `pnpm config list --json` printed in this repository with pnpm 12.9.0 on 2026-10-08, run from a script that `pnpm run` started. */
export const recordedPnpmConfig = {
  "@jsr:registry": "https://npm.jsr.io/",
  allowBuilds: { fsevents: false },
  blockExoticSubdeps: true,
  engineStrict: true,
  minimumReleaseAge: 1440,
  minimumReleaseAgeStrict: true,
  registries: {
    "https://npm.jsr.io/": { scopes: ["@jsr"] },
    "https://npm.pkg.github.com/": { prefix: "gh" },
    "https://registry.npmjs.org/": { scopes: ["@"], prefix: "npmjs" },
  },
  registry: "https://registry.npmjs.org/",
  saveExact: true,
  strictDepBuilds: true,
  trustPolicy: "no-downgrade",
  userAgent: "pnpm/12.9.0 npm/? node/? linux x64",
  verifyDepsBeforeRun: false,
};
