# bayan-web

The browser application of [BayanDocs](https://github.com/BayanDocs/docs): the same word processor as the desktop app, running in any modern browser, self-hostable, and laying out documents pixel-identically to the desktop because it runs the same engine.

This repository is a deliberately **thin shell**. The engine, [bayan-core](https://github.com/BayanDocs/bayan-core), is compiled to WebAssembly and runs in a Web Worker; this app provides the interface (rendered from the shared UI manifest), a compositor that draws engine-rendered page tiles, an input bridge for keyboards and input methods, an accessibility mirror for screen readers, offline support, and storage glue.

Built with TypeScript, React and Vite; packages managed with pnpm under a strict supply-chain policy.

> **Status: Phase 0 (Foundations).** No code yet. The first work package is [WEB-001](https://github.com/BayanDocs/docs/blob/HEAD/workpackages/phase-0/WEB-001-web-scaffold.md).

## Where things are decided

- Master plan: [docs/plan](https://github.com/BayanDocs/docs/tree/HEAD/plan)
- Web decision: [ADR-0014](https://github.com/BayanDocs/docs/blob/HEAD/adr/0014-web-shell.md); engine boundary: [ADR-0012](https://github.com/BayanDocs/docs/blob/HEAD/adr/0012-engine-boundary.md) and the [engine protocol](https://github.com/BayanDocs/docs/blob/HEAD/specs/engine-protocol.md)
- Work packages: [docs/workpackages](https://github.com/BayanDocs/docs/tree/HEAD/workpackages)

Contributors and agents: start with [AGENTS.md](AGENTS.md).

## License

Licensed under the GNU General Public License v3.0 or later ([LICENSE](LICENSE)) with the [BayanDocs App Store Permission](LICENSES/LicenseRef-BayanDocs-App-Store-Permission.txt), an additional permission under GPLv3 section 7 that allows distribution through app stores as long as the source code stays freely available to everyone. SPDX: `GPL-3.0-or-later WITH LicenseRef-BayanDocs-App-Store-Permission`. [REUSE.toml](REUSE.toml) records which license applies to which files, and [LICENSES/](LICENSES) holds the full texts. See the [licensing FAQ](https://github.com/BayanDocs/docs/blob/HEAD/LICENSING.md) and [ADR-0003](https://github.com/BayanDocs/docs/blob/HEAD/adr/0003-licensing-and-contribution-model.md).
