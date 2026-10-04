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

- **Licensing (ADR-0003):** GPL-3.0-or-later. The app shows a "Source code" link to the exact source of the running version, configurable by operators of modified versions (OPS-08); keep it working.
- **Thin shell (ADR-0014):** no document logic here. If something would have to be implemented twice (desktop and web), it belongs in bayan-core.
- **Engine in a Web Worker:** the main thread never calls the engine directly; it exchanges protocol messages (`docs/specs/engine-protocol.md`) with the worker and composites transferred tiles.
- **Stack:** React, TypeScript in strict mode, Vite, React Aria Components for interactive controls, Biome for lint and format, Vitest and Playwright for tests.
- **Package manager: pnpm only** (never npm or Yarn), pinned via `packageManager`, with `minimumReleaseAge: 1440` in strict mode, dependency build scripts blocked, `trustPolicy: no-downgrade`, exotic sub-dependencies blocked, and exact versions. CI installs with `--frozen-lockfile`.
- **Security (ADR-0014, ADR-0016):** strict Content Security Policy (no inline scripts, no `eval`; only `wasm-unsafe-eval`), Trusted Types, cross-origin isolation, `Integrity-Policy` with Subresource Integrity on every script, no third-party origins or CDNs at runtime, no analytics. Never use `dangerouslySetInnerHTML` or build HTML from strings; the accessibility mirror uses safe DOM APIs only.
- **Accessibility and input methods are features, not polish (ADR-0020):** every change keeps screen-reader and IME support working in Chromium, Firefox and WebKit.

## Verification gate

`pnpm verify` (created by WEB-001). Until WEB-001 has landed there is no code and no gate.

## Dependency mechanisms

pnpm enforces the 24-hour minimum age natively, including on frozen installs of the existing lockfile; a lockfile-integrity script and `pnpm audit` run in CI (X-003). Upgrades happen only in the monthly dependency session.
