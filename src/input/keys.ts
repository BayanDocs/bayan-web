// Which key presses the input bridges send to the engine as input.key (engine protocol §6.5), shared by both bridge implementations.
// The engine owns what keys mean; the shell only decides which presses are the document's (and stops the browser's own handling of them)
// and which belong to the browser: committed text arrives as input.text, never as input.key, and keys an input method is composing with
// stay with the input method.

import type { InputKey, Modifiers, UiCommand } from "../engine/protocol.ts";

/** Keys that edit or move through the document; they always go to the engine. Tab is not one: it moves focus on, so no keyboard trap. */
export const editingKeys: ReadonlySet<string> = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** A keyboard shortcut of the UI manifest (spec §6.8), such as "Ctrl+B". */
export interface Shortcut {
  /** The key, lower-case for letters, as KeyboardEvent.key gives it. */
  readonly key: string;
  /** The platform's primary modifier: Ctrl, or Command on Apple systems. */
  readonly primary: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** Parses a manifest shortcut ("Ctrl+Shift+B"); returns null for a form this shell does not understand. "Ctrl" is Command on Apple systems. */
export function parseShortcut(text: string): Shortcut | null {
  const parts = text.split("+");
  const key = parts.pop();
  if (key === undefined || key === "") return null;
  let primary = false;
  let shift = false;
  let alt = false;
  for (const part of parts) {
    if (part === "Ctrl" || part === "Cmd") primary = true;
    else if (part === "Shift") shift = true;
    else if (part === "Alt") alt = true;
    else return null;
  }
  return { key: key.length === 1 ? key.toLowerCase() : key, primary, shift, alt };
}

/** The shortcuts of the manifest's commands. */
export function manifestShortcuts(commands: readonly UiCommand[]): Shortcut[] {
  return commands.flatMap((command) => {
    const shortcut = command.shortcut ? parseShortcut(command.shortcut) : null;
    return shortcut === null ? [] : [shortcut];
  });
}

/** The parts of a KeyboardEvent the decision needs. */
export interface KeyPress {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly isComposing: boolean;
  readonly repeat: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export function modifiersOf(press: KeyPress): Modifiers {
  return { shift: press.shiftKey, ctrl: press.ctrlKey, alt: press.altKey, meta: press.metaKey };
}

/**
 * Decides what to do with a key press: the input.key to send (without doc_id) and whether to stop the browser's default action, or null
 * when the press is not the document's. Presses an input method composes with (isComposing, or keyCode 229, which WebKit also reports
 * for the key that ends a composition) are never sent. Clipboard shortcuts are left to the browser, so that its copy, cut and paste
 * events fire and the bridges can handle them.
 */
export function decideKey(
  press: KeyPress,
  shortcuts: readonly Shortcut[],
  apple: boolean,
): { message: Omit<InputKey, "doc_id">; preventDefault: true } | null {
  if (press.isComposing || press.keyCode === 229) return null;
  const message = {
    key: press.key,
    code: press.code,
    modifiers: modifiersOf(press),
    repeat: press.repeat,
    composing: false,
  };
  if (editingKeys.has(press.key)) return { message, preventDefault: true };
  const primary = apple ? press.metaKey : press.ctrlKey;
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;
  const matches = shortcuts.some(
    (shortcut) =>
      shortcut.key === key &&
      shortcut.primary === primary &&
      shortcut.shift === press.shiftKey &&
      shortcut.alt === press.altKey,
  );
  return matches ? { message, preventDefault: true } : null;
}

/** Whether this is an Apple system, where the primary shortcut modifier is Command. */
export function isApplePlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}
