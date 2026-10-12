// The input bridge for browsers with EditContext (Chromium): the editing surface is an element the app draws itself, and the browser
// reports text input and input-method composition as events instead of editing the element (https://w3c.github.io/edit-context/).
//
// The element holds the engine's editable text as plain DOM text, with the DOM selection at the engine's caret, which is what screen
// readers read; the EditContext holds the same text and caret, which is what input methods compose with. The bridge tells the
// EditContext where the control, the caret and each character are on screen, so the input method's window appears at the caret. Keys
// that edit or move are taken at keydown, before EditContext would apply them to its own copy of the text, and sent to the engine.

import {
  type BridgeOptions,
  type EditableState,
  type InputBridge,
  type InputSink,
  originTime,
  placeAt,
  type ScreenGeometry,
} from "./bridge.ts";
import { decideKey } from "./keys.ts";

export class EditContextBridge implements InputBridge {
  readonly kind = "edit-context";
  readonly element: HTMLDivElement;
  readonly #context: EditContext;
  readonly #text: Text;
  readonly #sink: InputSink;
  readonly #options: BridgeOptions;
  readonly #abort = new AbortController();
  #geometry: ScreenGeometry | undefined;
  #composing = false;
  #compositionText = "";
  #lastKeyDown = Number.NEGATIVE_INFINITY;

  constructor(sink: InputSink, options: BridgeOptions) {
    this.#sink = sink;
    this.#options = options;
    const element = document.createElement("div");
    element.className = "input-bridge";
    element.setAttribute("role", "textbox");
    element.setAttribute("aria-multiline", "true");
    element.tabIndex = 0;
    element.dataset["bridge"] = this.kind;
    this.#text = document.createTextNode("");
    element.append(this.#text);
    this.#context = new EditContext();
    element.editContext = this.#context;
    this.element = element;

    const signal = this.#abort.signal;
    const context = this.#context;
    context.addEventListener("textupdate", (event) => this.#textupdate(event), { signal });
    context.addEventListener("compositionstart", (event) => this.#compositionstart(event), { signal });
    context.addEventListener("compositionend", (event) => this.#compositionend(event), { signal });
    context.addEventListener(
      "characterboundsupdate",
      (event) => this.#characterBounds(event.rangeStart, event.rangeEnd),
      {
        signal,
      },
    );
    element.addEventListener("keydown", (event) => this.#keydown(event), { signal });
    element.addEventListener("paste", (event) => this.#paste(event), { signal });
    // Nothing can be selected in v0's mock document, so there is nothing to copy; the engine will supply clipboard content (spec §6).
    element.addEventListener("copy", (event) => event.preventDefault(), { signal });
    element.addEventListener("cut", (event) => event.preventDefault(), { signal });
    element.addEventListener("drop", (event) => event.preventDefault(), { signal });
    element.addEventListener("focus", () => this.#sink.focusChanged(true), { signal });
    element.addEventListener("blur", () => this.#sink.focusChanged(false), { signal });
  }

  focus(): void {
    this.element.focus({ preventScroll: true });
  }

  sync(state: EditableState): void {
    this.element.setAttribute("aria-label", state.name);
    if (this.#composing) return;
    if (this.#text.data !== state.text) this.#text.data = state.text;
    const context = this.#context;
    if (context.text !== state.text) context.updateText(0, context.text.length, state.text);
    if (state.caret !== null) {
      context.updateSelection(state.caret, state.caret);
      // The DOM selection is what screen readers follow; move it only while this element has focus, so it never steals the selection.
      if (document.activeElement === this.element) {
        document.getSelection()?.collapse(this.#text, Math.min(state.caret, this.#text.length));
      }
    }
  }

  place(geometry: ScreenGeometry): void {
    this.#geometry = geometry;
    placeAt(this.element, geometry.caret);
    this.#context.updateControlBounds(geometry.control);
    if (geometry.caret !== null) this.#context.updateSelectionBounds(geometry.caret);
  }

  destroy(): void {
    this.#abort.abort();
    this.element.editContext = null;
    this.element.remove();
  }

  #keydown(event: KeyboardEvent): void {
    this.#lastKeyDown = event.timeStamp;
    const decision = decideKey(event, this.#options.shortcuts(), this.#options.apple);
    if (decision === null) return;
    event.preventDefault();
    this.#sink.key(decision.message, event.timeStamp);
  }

  #textupdate(event: TextUpdateEvent): void {
    const time = originTime(event.timeStamp, this.#lastKeyDown);
    if (this.#composing) {
      // During a composition each update replaces the composition's text; the selection is the input method's caret inside it.
      this.#compositionText = event.text;
      const clamp = (offset: number) => Math.min(event.text.length, Math.max(0, offset - event.updateRangeStart));
      const selection = { start: clamp(event.selectionStart), end: clamp(event.selectionEnd) };
      this.#sink.composition("update", event.text, selection, time);
      return;
    }
    // Committed text. v0's protocol inserts at the caret only, so a replaced range (updateRangeStart < updateRangeEnd), which input
    // methods produce for reconversion, is not replaced (a protocol gap recorded in the WEB-002 report).
    if (event.text !== "") this.#sink.text(event.text, time);
  }

  #compositionstart(event: CompositionEvent): void {
    this.#composing = true;
    this.#compositionText = "";
    this.#sink.composition("start", "", null, event.timeStamp);
  }

  #compositionend(event: CompositionEvent): void {
    this.#composing = false;
    const committed = event.data !== "" ? event.data : this.#compositionText;
    this.#compositionText = "";
    this.#sink.composition("end", "", null, event.timeStamp);
    if (committed !== "") this.#sink.text(committed, event.timeStamp);
  }

  #characterBounds(start: number, end: number): void {
    const boxes = this.#geometry?.characters(start, end) ?? [];
    this.#context.updateCharacterBounds(start, boxes);
  }

  #paste(event: ClipboardEvent): void {
    event.preventDefault();
    // Only plain text, as committed text; richer formats must reach the engine as raw bytes (ADR-0006), which v0 cannot carry yet.
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text !== "") this.#sink.text(text, event.timeStamp);
  }
}
