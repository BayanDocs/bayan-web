// The module that config/engine-plugin.ts generates at build time: the paths and integrity hashes of the engine's files.
declare module "virtual:bayan-engine" {
  import type { EngineManifest } from "./engine-manifest.ts";

  export const engineFiles: EngineManifest;
}
