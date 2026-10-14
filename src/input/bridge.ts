// The input bridge (ADR-0014 §5): the one focusable, editable element through which keyboards, input methods and the clipboard reach the
// engine. Two implementations share this interface: EditContext where the browser has it (Chromium), and a hidden text area positioned at
// the caret elsewhere (Firefox, Safari). Both translate what the browser reports into the engine's input messages (spec §6.5) and keep
// the engine's editable text and caret in the element, so that input methods see the text around the caret and screen readers follow
// the caret (the caret-sync prototype of the accessibility mirror, src/a11y/mirror.ts).

import type { CompositionPhase, InputKey, TextRange } from "../engine/protocol.ts";
import type { Shortcut } from "./keys.ts";

/** Where a bridge sends what it receives. Times are performance.now() times of the key press or input event that caused the message. */
export interface InputSink {
  key(message: Omit<InputKey, "doc_id">, time: number): void;
  text(text: string, time: number): void;
  composition(phase: CompositionPhase, text: string, selection: TextRange | null, time: number): void;
  /** The bridge's element gained or lost keyboard focus. */
  focusChanged(focused: boolean): void;
}

/** The engine's editable text around the caret: the editable accessibility node and the accessibility caret (spec §6.6). */
export interface EditableState {
  /** The accessible name of the editable text. */
  readonly name: string;
  readonly text: string;
  /** The caret, in UTF-16 code units into `text`, or null when the caret is elsewhere. */
  readonly caret: number | null;
}

/** Where things are on screen, in CSS pixels relative to the viewport (client coordinates). */
export interface ScreenGeometry {
  /** The document's visible area. (DOMRect, not DOMRectReadOnly: Chromium's EditContext accepts only the former.) */
  readonly control: DOMRect;
  /** The caret, or null when it is not on screen. */
  readonly caret: DOMRect | null;
  /** The boxes of the editable text's characters from `start` to `end` (UTF-16 code units). */
  readonly characters: (start: number, end: number) => DOMRect[];
}

export interface BridgeOptions {
  /** The UI manifest's shortcuts, which the bridge sends to the engine instead of letting the browser act on them. */
  readonly shortcuts: () => readonly Shortcut[];
  /** Whether Command (not Ctrl) is the primary shortcut modifier. */
  readonly apple: boolean;
}

export interface InputBridge {
  readonly kind: "edit-context" | "hidden-element";
  /** The focusable element; it belongs in the accessibility mirror where the editable text is. */
  readonly element: HTMLElement;
  /** Gives the element keyboard focus without scrolling. */
  focus(): void;
  /** The engine's editable text or caret changed. While a composition is under way the bridge keeps its own text until it ends. */
  sync(state: EditableState): void;
  /** The caret or the view moved. */
  place(geometry: ScreenGeometry): void;
  destroy(): void;
}

/** The time a message should be measured from: the key press that caused it, if it came within the same moment, else the event itself. */
export function originTime(eventTime: number, lastKeyDown: number): number {
  return eventTime - lastKeyDown >= 0 && eventTime - lastKeyDown < 100 ? lastKeyDown : eventTime;
}

/** Positions the hidden element over a rectangle in client coordinates. */
export function placeAt(element: HTMLElement, rect: DOMRectReadOnly | null): void {
  if (rect === null) return;
  element.style.left = `${Math.round(rect.left)}px`;
  element.style.top = `${Math.round(rect.top)}px`;
  element.style.height = `${Math.max(1, Math.round(rect.height))}px`;
  element.style.fontSize = `${Math.max(1, Math.round(rect.height * 0.8))}px`;
}
