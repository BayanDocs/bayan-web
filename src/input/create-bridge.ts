// Chooses the input bridge for this browser (ADR-0014 §5): EditContext where it exists, the hidden text area elsewhere.

import type { BridgeOptions, InputBridge, InputSink } from "./bridge.ts";
import { EditContextBridge } from "./edit-context-bridge.ts";
import { HiddenElementBridge } from "./hidden-element-bridge.ts";

export function createInputBridge(sink: InputSink, options: BridgeOptions): InputBridge {
  return typeof globalThis.EditContext === "function"
    ? new EditContextBridge(sink, options)
    : new HiddenElementBridge(sink, options);
}
