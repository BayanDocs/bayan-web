// A Vite plugin that serves the engine's WebAssembly package (config/engine-files.ts) with the app, unchanged, byte for byte:
// - in builds it emits the runtime files into assets/engine-<digest>/ and the licence notices into engine-licenses/;
// - on the development server it serves the same files at the same paths, with the development security headers;
// - it gives the app's code the files' paths and Subresource Integrity hashes as the module "virtual:bayan-engine", so that the app,
//   whose own scripts index.html loads with integrity hashes, can check the engine's files before it starts the worker
//   (src/engine/start.ts; the integrity plan is in docs/spikes/WEB-002-report.md).
// The package is read when a build or the development server starts, not when this file is imported, so the unit tests that import
// vite.config.ts work without it.

import type { Plugin } from "vite";
import { type EngineBuild, type EngineFile, engineManifest, readEngineBuild } from "./engine-files.ts";

const virtualId = "virtual:bayan-engine";
const resolvedVirtualId = `\0${virtualId}`;

const contentTypes: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  // WebAssembly streaming compilation needs exactly this type.
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

function contentType(name: string): string {
  const extension = /\.[a-z]+$/.exec(name)?.[0] ?? "";
  return contentTypes[extension] ?? "application/octet-stream";
}

export interface EnginePluginOptions {
  /** The headers the development server sends with every response (config/security-headers.ts). */
  devHeaders: Readonly<Record<string, string>>;
  /** The package folder; defaults to engine-package/. */
  packageDir?: string;
}

export function bayanEngine(options: EnginePluginOptions): Plugin {
  let build: EngineBuild | undefined;
  const engine = (): EngineBuild => {
    build ??= options.packageDir === undefined ? readEngineBuild() : readEngineBuild(options.packageDir);
    return build;
  };
  const files = (): EngineFile[] => [...Object.values(engine().runtime), ...engine().notices];

  return {
    name: "bayan-engine",

    resolveId(id) {
      return id === virtualId ? resolvedVirtualId : undefined;
    },

    load(id) {
      if (id !== resolvedVirtualId) return undefined;
      return `export const engineFiles = Object.freeze(${JSON.stringify(engineManifest(engine()))});\n`;
    },

    configureServer(server) {
      // Read the package when the server starts, so a missing package is reported at once rather than on the first request.
      engine();
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split(/[?#]/, 1)[0] ?? "";
        const file = files().find((candidate) => `/${candidate.path}` === path);
        if (file === undefined || (request.method !== "GET" && request.method !== "HEAD")) {
          next();
          return;
        }
        for (const [name, value] of Object.entries(options.devHeaders)) response.setHeader(name, value);
        response.setHeader("Content-Type", contentType(file.name));
        response.setHeader("Content-Length", String(file.bytes.byteLength));
        response.setHeader("Cache-Control", "no-cache");
        response.statusCode = 200;
        response.end(request.method === "HEAD" ? undefined : file.bytes);
      });
    },

    generateBundle() {
      for (const file of files()) {
        this.emitFile({ type: "asset", fileName: file.path, source: file.bytes });
      }
    },
  };
}
