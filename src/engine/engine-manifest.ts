// What the app learns about the engine's files at build time (config/engine-files.ts writes it; src/engine/engine-files.d.ts types it).
// A separate module without Node.js imports, so that both the browser code and the build configuration can use the type.

/** A file of the engine that the app serves: its absolute same-origin URL path and its Subresource Integrity hash. */
export interface EngineFileEntry {
  readonly url: string;
  readonly integrity: string;
}

export interface EngineManifest {
  /** The bayan-core commit the engine package was built from (bayan-core.pin). */
  readonly commit: string;
  /** The engine's semantic version. */
  readonly version: string;
  /** The worker host, bayan-worker.js: the worker's entry script. */
  readonly worker: EngineFileEntry;
  /** wasm-bindgen's glue, bayan_wasm.js, which the worker host imports. */
  readonly glue: EngineFileEntry;
  /** The engine module, bayan_wasm_bg.wasm, which the glue fetches. */
  readonly wasm: EngineFileEntry;
  /** The licence notices of the Rust code compiled into the engine. */
  readonly notices: { readonly url: string };
}
