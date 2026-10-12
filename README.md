# bayan-web

The browser application of [BayanDocs](https://github.com/BayanDocs/docs): the same word processor as the desktop app, running in any modern browser, self-hostable, and laying out documents pixel-identically to the desktop because it runs the same engine.

This repository is a deliberately **thin shell**. The engine, [bayan-core](https://github.com/BayanDocs/bayan-core), is compiled to WebAssembly and runs in a Web Worker; this app provides the interface (rendered from the shared UI manifest), a compositor that draws engine-rendered page tiles, an input bridge for keyboards and input methods, an accessibility mirror for screen readers, offline support, and storage glue.

Built with TypeScript, React and Vite; packages managed with pnpm under a strict supply-chain policy.

> **Status: Phase 0 (Foundations).** The application skeleton, security hardening and verification gate are in place ([WEB-001](https://github.com/BayanDocs/docs/blob/HEAD/workpackages/phase-0/WEB-001-web-scaffold.md)), and the spike of [WEB-002](https://github.com/BayanDocs/docs/blob/HEAD/workpackages/phase-0/WEB-002-spike-worker-canvas.md) runs bayan-core's engine skeleton in a Web Worker and shows its mock document: a tile compositor, input bridges for keyboards and input methods, and an accessibility mirror for screen readers. Its findings are in [docs/spikes/WEB-002-report.md](docs/spikes/WEB-002-report.md).

## Getting started

**Supported development platforms:** Ubuntu 24.04 on x86-64, and macOS 14 or later on Apple Silicon or Intel. CI checks every change on Ubuntu 24.04, on macOS 15 with Apple Silicon and on macOS 26 with Intel.

Run `scripts/dev-setup.sh` once, and again whenever it changes. It installs everything at pinned versions and checks every download against a known hash: Node.js 24 (`.nvmrc`), pnpm (its native binary, checked against the sha512 that `pnpm-lock.yaml` records for it; no Corepack needed), the project's packages, and the browser builds the tests use. Playwright tells the script which browser builds your machine needs, and the script refuses any build it has no pinned hash for. When the script puts Node.js or pnpm in its own folder (`~/.local/share/bayandocs`), it prints the `export PATH=…` line to add to your shell profile.

Then build the engine with `scripts/engine-package.sh`, and again whenever `bayan-core.pin` changes. The app runs [bayan-core](https://github.com/BayanDocs/bayan-core)'s engine as WebAssembly, and until bayan-core publishes releases the web app builds it from the commit named in `bayan-core.pin` (ADR-0002 §4). The script needs `git` and [rustup](https://rustup.rs): it clones bayan-core into `~/.cache/bayandocs/bayan-core`, refuses a commit that is not on bayan-core's main branch, installs bayan-core's pinned Rust toolchain and wasm-bindgen with bayan-core's own setup script, and writes the package to `engine-package/` (about a minute after the first run). With a bayan-core checkout of the pinned commit at hand, as in BayanDocs cloud sessions, `BAYAN_CORE_DIR=/home/user/bayan-core scripts/engine-package.sh` builds from it instead of cloning.

- **Ubuntu 24.04:** the script also installs the browsers' system libraries from a frozen, signed Ubuntu archive snapshot, which needs `sudo`.
- **macOS:** open Terminal in the repository and run `scripts/dev-setup.sh`. Nothing needs installing first: the script works with what macOS includes (bash 3.2, curl, unzip, tar and shasum). The browsers go to `~/Library/Caches/ms-playwright`, where Playwright looks for them.
- **Other systems** are not supported by the script. You can still install Node.js 24.21.0 and pnpm 12.9.0 yourself and the browsers with `pnpm exec playwright install chromium-headless-shell firefox webkit`, but those downloads are not checked against our pins.

| Command | What it does |
|---|---|
| `pnpm dev` | Development server at http://localhost:5173 with the same security headers as production (except `Integrity-Policy`). |
| `pnpm build` | Production build in `dist/`, then Subresource Integrity hashes and a size report. |
| `pnpm preview` | Serves `dist/` at http://localhost:4173 with the production security headers. |
| `scripts/engine-package.sh` | Builds the engine's WebAssembly package from the bayan-core commit in `bayan-core.pin` into `engine-package/`, which the dev server, the build and the tests need. |
| `pnpm verify` | The full verification gate: policy check, lockfile integrity check, engine check (`engine-package/` was built from the pinned commit), lint, type check, unit tests, build, end-to-end tests and measurements in Chromium, Firefox and WebKit, and the audit (fails on high and critical advisories). Run it before every push. |
| `pnpm format` | Formats the code with Biome. |

Use pnpm only, never npm or Yarn; the dependency rules are in [AGENTS.md](AGENTS.md#dependency-mechanisms).

**BayanDocs cloud sessions:** the cloud environment's setup script ([docs/scripts/cloud-environment-setup.sh](https://github.com/BayanDocs/docs/blob/main/scripts/cloud-environment-setup.sh), from version 2026-10-04.4) runs this script for you with the line below, just above its final `exit 0`, so the browsers are ready in every session. If your environment still runs an older version of that script, paste this line there yourself, above the final `exit 0` (a line after it would never run). It does nothing when bayan-web is not attached to the session, never makes the session fail, and logs to `/var/log/bayandocs-setup/bayan-web.log`:

```sh
if [ -x /home/user/bayan-web/scripts/dev-setup.sh ]; then /home/user/bayan-web/scripts/dev-setup.sh >/var/log/bayandocs-setup/bayan-web.log 2>&1 || echo "bayan-web dev-setup failed; see /var/log/bayandocs-setup/bayan-web.log"; fi
```

## Repository map

| Path | Contents |
|---|---|
| `src/` | The React application: the frame with its ribbon and document regions, themes and controls; `engine/` (starting the engine's worker and the main thread's side of the protocol), `view/` (the tile compositor and the document view's controller), `input/` (the two input bridges), `a11y/` (the accessibility mirror) and `security/` (the one Trusted Types policy). |
| `bayan-core.pin`, `config/engine-*.ts` | The bayan-core commit whose engine the app serves, and how the build serves its files (`engine-files.ts`, `engine-plugin.ts`). |
| `config/security-headers.ts` | The HTTP security headers (Content Security Policy, Trusted Types, cross-origin isolation, `Integrity-Policy`), used by the dev and preview servers. |
| `deploy/nginx/` | A sample production configuration that sends the same headers; a unit test keeps it in sync. |
| `scripts/` | `dev-setup.sh` (tool installation), `pnpm-binary.ts` (finds and checks pnpm's native binary), `check-policy.ts` (dependency policy check), `check-lockfile-integrity.ts` (where the locked packages come from), `audit.ts` (the audit gate), `pnpm-settings.ts` and `strict-yaml.ts` (how those three read pnpm's settings and YAML files), `sri.ts` (integrity hashes), `check-licenses.ts` (third-party licence notices), `size-report.ts` (size budgets), `engine-package.sh` (builds the engine package) and `check-engine.ts` (checks it against the pin). |
| `docs/spikes/` | Reports of spikes: what was tried, measured and decided (WEB-002). |
| `tests/unit/`, `tests/e2e/` | Vitest unit tests and Playwright end-to-end tests. |
| `pnpm-workspace.yaml`, `.npmrc` | Package-manager settings that enforce the supply-chain policy (ADR-0017). |

## Deploying

Serve the `dist/` folder that `pnpm build` produces, with the security headers from `config/security-headers.ts`; `deploy/nginx/` is a sample nginx configuration. Keep `third-party-licenses.txt` published next to `index.html`: the app's "Licenses" link points to it, and the licences of the bundled packages (MIT and Apache-2.0) require their notices whenever the code is redistributed, which every page load does. Treat it like the "Source code" link that OPS-08 requires: operators of modified versions must keep both working. The same holds for the folder `engine-licenses/`, the notices of the Rust code compiled into the engine, which the app's "Engine licenses" link opens. The engine's files are served from a content-addressed folder `assets/engine-<digest>/`, so they can be cached for a year like the rest of `assets/`; serve `.wasm` files as `application/wasm`.

## Where things are decided

- Master plan: [docs/plan](https://github.com/BayanDocs/docs/tree/HEAD/plan)
- Web decision: [ADR-0014](https://github.com/BayanDocs/docs/blob/HEAD/adr/0014-web-shell.md); engine boundary: [ADR-0012](https://github.com/BayanDocs/docs/blob/HEAD/adr/0012-engine-boundary.md) and the [engine protocol](https://github.com/BayanDocs/docs/blob/HEAD/specs/engine-protocol.md)
- Work packages: [docs/workpackages](https://github.com/BayanDocs/docs/tree/HEAD/workpackages)

Contributors and agents: start with [AGENTS.md](AGENTS.md).

## License

Licensed under the GNU General Public License v3.0 or later ([LICENSE](LICENSE)) with the [BayanDocs App Store Permission](LICENSES/LicenseRef-BayanDocs-App-Store-Permission.txt), an additional permission under GPLv3 section 7 that allows distribution through app stores as long as the source code stays freely available to everyone. SPDX: `GPL-3.0-or-later WITH LicenseRef-BayanDocs-App-Store-Permission`. [REUSE.toml](REUSE.toml) records which license applies to which files, and [LICENSES/](LICENSES) holds the full texts. See the [licensing FAQ](https://github.com/BayanDocs/docs/blob/HEAD/LICENSING.md) and [ADR-0003](https://github.com/BayanDocs/docs/blob/HEAD/adr/0003-licensing-and-contribution-model.md).
