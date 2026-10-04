# bayan-web

The browser application of [BayanDocs](https://github.com/BayanDocs/docs): the same word processor as the desktop app, running in any modern browser, self-hostable, and laying out documents pixel-identically to the desktop because it runs the same engine.

This repository is a deliberately **thin shell**. The engine, [bayan-core](https://github.com/BayanDocs/bayan-core), is compiled to WebAssembly and runs in a Web Worker; this app provides the interface (rendered from the shared UI manifest), a compositor that draws engine-rendered page tiles, an input bridge for keyboards and input methods, an accessibility mirror for screen readers, offline support, and storage glue.

Built with TypeScript, React and Vite; packages managed with pnpm under a strict supply-chain policy.

> **Status: Phase 0 (Foundations).** The application skeleton, security hardening and verification gate are in place ([WEB-001](https://github.com/BayanDocs/docs/blob/HEAD/workpackages/phase-0/WEB-001-web-scaffold.md)); the engine worker, page canvas and input bridge come next ([WEB-002](https://github.com/BayanDocs/docs/blob/HEAD/workpackages/phase-0/WEB-002-spike-worker-canvas.md)).

## Getting started

Run `scripts/dev-setup.sh` once. It installs everything at pinned versions and checks every download against a known hash: Node.js 24 (`.nvmrc`), pnpm (through Corepack), the project's packages, and the browser builds the tests use. Automatic installs of Node.js and the browsers cover Linux on x86-64 (Ubuntu 24.04 for the browsers); on other systems install Node.js 24.21.0 yourself (for example with nvm or fnm, which read `.nvmrc`) and the script tells you how to get the browsers.

| Command | What it does |
|---|---|
| `pnpm dev` | Development server at http://localhost:5173 with the same security headers as production (except `Integrity-Policy`). |
| `pnpm build` | Production build in `dist/`, then Subresource Integrity hashes and a size report. |
| `pnpm preview` | Serves `dist/` at http://localhost:4173 with the production security headers. |
| `pnpm verify` | The full verification gate: policy check, lint, type check, unit tests, build, end-to-end tests in Chromium, Firefox and WebKit, and `pnpm audit`. Run it before every push. |
| `pnpm format` | Formats the code with Biome. |

Use pnpm only, never npm or Yarn; the dependency rules are in [AGENTS.md](AGENTS.md#dependency-mechanisms).

**BayanDocs cloud sessions:** to have the browsers ready in every session, add this line to the cloud environment's setup script on the line just above its final `exit 0` (a line after that would never run). It does nothing when bayan-web is not attached to the session, never makes the session fail, and logs to `/var/log/bayandocs-setup/bayan-web.log`:

```sh
if [ -x /home/user/bayan-web/scripts/dev-setup.sh ]; then /home/user/bayan-web/scripts/dev-setup.sh >/var/log/bayandocs-setup/bayan-web.log 2>&1 || echo "bayan-web dev-setup failed; see /var/log/bayandocs-setup/bayan-web.log"; fi
```

## Repository map

| Path | Contents |
|---|---|
| `src/` | The React application: the frame with its ribbon and canvas regions, themes and controls. |
| `config/security-headers.ts` | The HTTP security headers (Content Security Policy, Trusted Types, cross-origin isolation, `Integrity-Policy`), used by the dev and preview servers. |
| `deploy/nginx/` | A sample production configuration that sends the same headers; a unit test keeps it in sync. |
| `scripts/` | `dev-setup.sh` (tool installation), `check-policy.ts` (dependency policy check), `sri.ts` (integrity hashes) and `size-report.ts` (bundle size budget). |
| `tests/unit/`, `tests/e2e/` | Vitest unit tests and Playwright end-to-end tests. |
| `pnpm-workspace.yaml`, `.npmrc` | Package-manager settings that enforce the supply-chain policy (ADR-0017). |

## Where things are decided

- Master plan: [docs/plan](https://github.com/BayanDocs/docs/tree/HEAD/plan)
- Web decision: [ADR-0014](https://github.com/BayanDocs/docs/blob/HEAD/adr/0014-web-shell.md); engine boundary: [ADR-0012](https://github.com/BayanDocs/docs/blob/HEAD/adr/0012-engine-boundary.md) and the [engine protocol](https://github.com/BayanDocs/docs/blob/HEAD/specs/engine-protocol.md)
- Work packages: [docs/workpackages](https://github.com/BayanDocs/docs/tree/HEAD/workpackages)

Contributors and agents: start with [AGENTS.md](AGENTS.md).

## License

Licensed under the GNU General Public License v3.0 or later ([LICENSE](LICENSE)) with the [BayanDocs App Store Permission](LICENSES/LicenseRef-BayanDocs-App-Store-Permission.txt), an additional permission under GPLv3 section 7 that allows distribution through app stores as long as the source code stays freely available to everyone. SPDX: `GPL-3.0-or-later WITH LicenseRef-BayanDocs-App-Store-Permission`. [REUSE.toml](REUSE.toml) records which license applies to which files, and [LICENSES/](LICENSES) holds the full texts. See the [licensing FAQ](https://github.com/BayanDocs/docs/blob/HEAD/LICENSING.md) and [ADR-0003](https://github.com/BayanDocs/docs/blob/HEAD/adr/0003-licensing-and-contribution-model.md).
