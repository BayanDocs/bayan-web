// The input bridge for browsers without EditContext (Firefox and Safari): a text area that the user never sees, positioned at the caret.
//
// It holds the engine's editable text with its own caret where the engine's is, so that input methods compose with the text around them
// and screen readers read what the caret moves over. It never decides anything itself: typed text, deletions and pastes are cancelled
// (beforeinput, paste) and sent to the engine, which answers with the new text that sync() writes back. Composition cannot be cancelled,
// so it happens in the text area, is forwarded as it goes, and is replaced by the engine's text once it ends. The text area does not wrap
// and is a few pixels wide, so the browser keeps its caret, and with it the input method's window, at the engine's caret.

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

/** Engine key messages for beforeinput deletions that did not come from a key the bridge already sent (input methods, menus). */
const deletions: Readonly<Record<string, { key: string; ctrl?: boolean; alt?: boolean }>> = {
  deleteContentBackward: { key: "Backspace" },
  deleteContentForward: { key: "Delete" },
  deleteWordBackward: { key: "Backspace", ctrl: true },
  deleteWordForward: { key: "Delete", ctrl: true },
};

export class HiddenElementBridge implements InputBridge {
  readonly kind = "hidden-element";
  readonly element: HTMLTextAreaElement;
  readonly #sink: InputSink;
  readonly #options: BridgeOptions;
  readonly #abort = new AbortController();
  #state: EditableState = { name: "", text: "", caret: null };
  #composing = false;
  /** Where the composition began, and the text it began in: the engine's text changes while it shows the composition. */
  #compositionStart = 0;
  #compositionBase = "";
  #lastKeyDown = Number.NEGATIVE_INFINITY;

  constructor(sink: InputSink, options: BridgeOptions) {
    this.#sink = sink;
    this.#options = options;
    const element = document.createElement("textarea");
    element.className = "input-bridge";
    element.rows = 1;
    element.wrap = "off";
    element.spellcheck = false;
    element.autocomplete = "off";
    element.setAttribute("autocorrect", "off");
    element.setAttribute("autocapitalize", "off");
    element.dataset["bridge"] = this.kind;
    this.element = element;
    const signal = this.#abort.signal;
    element.addEventListener("keydown", (event) => this.#keydown(event), { signal });
    element.addEventListener("beforeinput", (event) => this.#beforeinput(event), { signal });
    element.addEventListener("input", (event) => this.#input(event as InputEvent), { signal });
    element.addEventListener("compositionstart", (event) => this.#compositionstart(event), { signal });
    element.addEventListener("compositionend", (event) => this.#compositionend(event), { signal });
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
    this.#state = state;
    this.element.setAttribute("aria-label", state.name);
    if (!this.#composing) this.#write();
  }

  place(geometry: ScreenGeometry): void {
    placeAt(this.element, geometry.caret);
  }

  destroy(): void {
    this.#abort.abort();
    this.element.remove();
  }

  /** Writes the engine's text and caret into the text area, unless they are there already (rewriting would disturb screen readers). */
  #write(): void {
    const { text, caret } = this.#state;
    if (this.element.value !== text) this.element.value = text;
    if (caret !== null && (this.element.selectionStart !== caret || this.element.selectionEnd !== caret)) {
      this.element.setSelectionRange(caret, caret);
    }
  }

  #keydown(event: KeyboardEvent): void {
    this.#lastKeyDown = event.timeStamp;
    const decision = decideKey(event, this.#options.shortcuts(), this.#options.apple);
    if (decision === null) return;
    event.preventDefault();
    this.#sink.key(decision.message, event.timeStamp);
  }

  #beforeinput(event: InputEvent): void {
    if (this.#composing || event.isComposing) return;
    const time = originTime(event.timeStamp, this.#lastKeyDown);
    switch (event.inputType) {
      case "insertCompositionText":
      case "deleteCompositionText":
      case "insertFromComposition":
        // Composition is not cancellable; it is forwarded by the composition and input events.
        return;
      case "insertText":
      case "insertReplacementText": {
        // insertReplacementText (autocorrect, spelling suggestions) should replace a range; v0's protocol can only insert at the caret,
        // so the replacement is inserted (a protocol gap recorded in the WEB-002 report). Both are switched off on this element.
        const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
        event.preventDefault();
        if (text !== "") this.#sink.text(text, time);
        return;
      }
      case "insertLineBreak":
      case "insertParagraph":
        event.preventDefault();
        this.#sink.key({ key: "Enter", code: "", modifiers: {}, repeat: false, composing: false }, time);
        return;
      default: {
        event.preventDefault();
        const deletion = deletions[event.inputType];
        if (deletion !== undefined) {
          const modifiers = { ctrl: deletion.ctrl === true, alt: deletion.alt === true };
          this.#sink.key({ key: deletion.key, code: "", modifiers, repeat: false, composing: false }, time);
        }
      }
    }
  }

  #input(event: InputEvent): void {
    if (this.#composing) {
      // The composition's text is what the input method added to the engine's text, starting where the caret was.
      const added = this.element.value.length - this.#compositionBase.length;
      const text = this.element.value.slice(this.#compositionStart, this.#compositionStart + Math.max(0, added));
      const clamp = (offset: number | null) =>
        Math.min(text.length, Math.max(0, (offset ?? 0) - this.#compositionStart));
      const selection = { start: clamp(this.element.selectionStart), end: clamp(this.element.selectionEnd) };
      this.#sink.composition("update", text, selection, event.timeStamp);
      return;
    }
    // Firefox delivers the input event of a finished composition after compositionend, which already sent the text. Anything else that
    // changed the text area without the engine (a browser feature this bridge does not know) is undone: the engine's text is the truth.
    if (event.inputType !== "insertCompositionText") this.#write();
  }

  #compositionstart(event: CompositionEvent): void {
    this.#composing = true;
    this.#compositionStart = this.element.selectionStart;
    this.#compositionBase = this.element.value;
    this.#sink.composition("start", "", null, event.timeStamp);
  }

  #compositionend(event: CompositionEvent): void {
    this.#composing = false;
    this.#sink.composition("end", "", null, event.timeStamp);
    if (event.data !== "") this.#sink.text(event.data, event.timeStamp);
    // The text area still shows the committed text; the engine's answer, through sync(), replaces it with the engine's text.
  }

  #paste(event: ClipboardEvent): void {
    event.preventDefault();
    // Only plain text, as committed text. Richer formats must reach the engine as raw bytes, never decoded by the browser (ADR-0006);
    // v0's protocol has no message for them yet (WEB-002 report).
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text !== "") this.#sink.text(text, event.timeStamp);
  }
}
