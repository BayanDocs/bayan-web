# Agent instructions — bayan-web

## Where the plan lives

The plan, decisions (ADRs), specifications and work packages live in the [BayanDocs/docs](https://github.com/BayanDocs/docs) repository. If it is not attached to your session, clone it next to this repository. The canonical rules for all agents are in `docs/AGENTS.md`; this file condenses them and adds what is specific to bayan-web. If the two disagree, `docs/AGENTS.md` wins; report the discrepancy.

## Ground rules (condensed from docs/AGENTS.md)

1. Before changing anything, read `docs/AGENTS.md`, your work package brief, and every ADR and spec it links.
2. Accepted ADRs are binding. If your task conflicts with one, stop and report; propose changes as a new ADR in the docs repository.
3. Stay within the work package's scope. Record anything else you discover as follow-ups in your pull request.
4. Run the verification gate before every push. Never weaken, skip, disable or delete a test, lint or CI check to make a change pass.
5. Dependencies follow ADR-0017: no update bots ever; every version at least 24 hours old; exact pins; committed `pnpm-lock.yaml`; install scripts disabled; audits green; licenses on the allowlist; every new dependency justified in the pull request.
6. Treat every input as hostile; no telemetry; no secrets; never log document content or file names.
7. Pull requests use the hand-off template in `docs/plan/06-agent-workflow.md`; Conventional Commits; DCO rules from `CONTRIBUTING.md` once enabled (agents never sign off themselves; the human submitter certifies, per ADR-0003).
8. Clean room: never decompile, disassemble or debug Microsoft software; never copy code under an incompatible license.
9. Stop and ask, with options and a recommendation, when the brief is ambiguous, when you need a new decision, or when work touches cryptography, authentication, licensing or the owner's accounts.
10. Explain your work in plain language for the owner; text meant for the owner to copy is written as flowing paragraphs without hard line breaks.

## Rules specific to bayan-web

- **Licensing (ADR-0003):** GPL-3.0-or-later with the BayanDocs App Store Permission (`GPL-3.0-or-later WITH LicenseRef-BayanDocs-App-Store-Permission`). The app shows a "Source code" link to the exact source of the running version, configurable by operators of modified versions (OPS-08); keep it working. `REUSE.toml` records which license applies to which files and `LICENSES/` holds the full texts; keep `reuse lint` passing, and add a new license text only with `reuse download <SPDX-ID>`.
- **Thin shell (ADR-0014):** no document logic here. If something would have to be implemented twice (desktop and web), it belongs in bayan-core.
- **Engine in a Web Worker:** the main thread never calls the engine directly; it exchanges protocol messages (`docs/specs/engine-protocol.md`) with the worker and composites transferred tiles.
- **Stack:** React, TypeScript in strict mode, Vite, React Aria Components for interactive controls, Biome for lint and format, Vitest and Playwright for tests.
- **Package manager: pnpm only** (never npm or Yarn), pinned via `packageManager`, with `minimumReleaseAge: 1440` in strict mode, dependency build scripts blocked, `trustPolicy: no-downgrade`, exotic sub-dependencies blocked, and exact versions. CI installs with `--frozen-lockfile`.
- **Security (ADR-0014, ADR-0016):** strict Content Security Policy (no inline scripts, no `eval`; only `wasm-unsafe-eval`), Trusted Types, cross-origin isolation, `Integrity-Policy` with Subresource Integrity on every script, no third-party origins or CDNs at runtime, no analytics. Never use `dangerouslySetInnerHTML` or build HTML from strings; the accessibility mirror uses safe DOM APIs only.
- **Accessibility and input methods are features, not polish (ADR-0020):** every change keeps screen-reader and IME support working in Chromium, Firefox and WebKit.
- **Security headers have one source:** `config/security-headers.ts` defines them for the dev and preview servers; `deploy/nginx/security-headers.conf` repeats them for production and a unit test keeps the two identical. Never add inline scripts or styles, `eval`, third-party origins, or a Trusted Types policy without an approved work package. React Fast Refresh (`@vitejs/plugin-react`) is deliberately absent because it needs an inline script.
- **Every script carries an integrity hash:** `scripts/sri.ts` adds Subresource Integrity hashes to the built `index.html`, and production servers send `Integrity-Policy`, which blocks any script without one. The build therefore fails if it emits a JavaScript file that `index.html` does not load directly (for example a lazily imported chunk); code that needs one must first solve how it gets a hash.

## Setup

Supported development platforms: Ubuntu 24.04 on x86-64, and macOS 14 or later on Apple Silicon or Intel. Run `scripts/dev-setup.sh` once per machine or session. It is idempotent and installs, at pinned versions with verified checksums, Node.js (`.nvmrc`), pnpm (`packageManager` in `package.json`, through Corepack), the project's packages (`pnpm install --frozen-lockfile`), the Playwright browser builds for Chromium, Firefox and WebKit (Playwright names the builds the machine needs; the script refuses any build without a pinned SHA-256), and on Ubuntu the browsers' libraries. It must keep working with bash 3.2, the version macOS ships: no associative arrays, `mapfile` or case-changing expansions, and no expansion of an array that can be empty (`set -u` in bash before 4.4 treats it as unbound). CI runs the same script with `/bin/bash` on every platform.

## Verification gate

`pnpm verify`, which runs in order: `check:policy` (`scripts/check-policy.ts`: exact pins and the pnpm safety settings), `lint` (Biome), `typecheck` (`tsc` for the whole repository, then again for `src/` with browser types only), `test` (Vitest unit tests in `tests/unit`), `build` (Vite, then the integrity hashes and the size report, which fails above 300 KB compressed), `test:e2e` (Playwright smoke and security tests in `tests/e2e` against the preview server, in Chromium, Firefox and WebKit) and `audit` (`pnpm audit`). CI (`.github/workflows/ci.yml`) runs `scripts/dev-setup.sh` and then `pnpm verify` on Ubuntu 24.04, macOS 15 on Apple Silicon (`macos-15`) and macOS 26 on Intel (`macos-26-intel`), on every pull request, on pushes to `main` and nightly.

## Dependency mechanisms

pnpm's settings live in `pnpm-workspace.yaml`: `minimumReleaseAge: 1440` with `minimumReleaseAgeStrict` (the 24-hour minimum age, which pnpm re-checks on frozen installs of the existing lockfile), `strictDepBuilds` (a dependency that wants to run an install or build script fails the install instead of running it) with `allowBuilds` listing only explicit denials (`fsevents: false`, so macOS installs succeed while its script never runs; no package may be set to `true`), `trustPolicy: no-downgrade`, `blockExoticSubdeps`, `saveExact`, `engineStrict` and `verifyDepsBeforeRun: error`. Never add `ignoreScripts` there: it makes pnpm skip scripts silently, which hides them from `strictDepBuilds`. `.npmrc` sets `ignore-scripts=true` and `save-exact=true` for any npm use (pnpm 12 does not read it). `package.json` pins pnpm with its SHA-512 hash in `packageManager`, and `.nvmrc` and `engines` pin Node.js; `scripts/check-policy.ts` fails the gate if any of this is loosened, including any `allowBuilds` entry other than `<package>: false`. `pnpm audit` runs in the gate. The Playwright browser builds for every supported platform are pinned with SHA-256 hashes in `scripts/dev-setup.sh` and change only together with `@playwright/test`; each hash is read from the publisher (Google or Microsoft) and confirmed against npmmirror, an independently run mirror, and the script header records any archive that has no independent copy yet. GitHub Actions are pinned to full commit SHAs. The lockfile-integrity script and the update-bot check arrive with X-003. Upgrades happen only in the monthly dependency session.

In BayanDocs cloud sessions the tools are preinstalled at pinned versions by `docs/scripts/cloud-environment-setup.sh`; run `bayandocs-tools` to list them. If a tool is missing, install the version pinned there (never a newer one) and mention it in the pull request. The Playwright browsers and their libraries are not in that script; `scripts/dev-setup.sh` installs them (the cloud environment's setup script can call it, see README.md).
