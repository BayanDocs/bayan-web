// The EditContext API (W3C EditContext, https://w3c.github.io/edit-context/), which TypeScript's DOM types do not include yet. Only the
// parts the input bridge uses. Chromium has it since version 121; Firefox and Safari do not (ADR-0014).

interface TextUpdateEvent extends Event {
  readonly updateRangeStart: number;
  readonly updateRangeEnd: number;
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

interface CharacterBoundsUpdateEvent extends Event {
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

interface EditContextEventMap {
  textupdate: TextUpdateEvent;
  textformatupdate: Event;
  characterboundsupdate: CharacterBoundsUpdateEvent;
  compositionstart: CompositionEvent;
  compositionend: CompositionEvent;
}

interface EditContext extends EventTarget {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly characterBoundsRangeStart: number;
  updateText(rangeStart: number, rangeEnd: number, text: string): void;
  updateSelection(start: number, end: number): void;
  updateControlBounds(controlBounds: DOMRect): void;
  updateSelectionBounds(selectionBounds: DOMRect): void;
  updateCharacterBounds(rangeStart: number, characterBounds: DOMRect[]): void;
  addEventListener<K extends keyof EditContextEventMap>(
    type: K,
    listener: (event: EditContextEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
}

declare var EditContext: {
  prototype: EditContext;
  new (init?: { text?: string; selectionStart?: number; selectionEnd?: number }): EditContext;
};

interface HTMLElement {
  editContext: EditContext | null;
}
