// Which key presses the input bridges send to the engine as input.key (engine protocol §14.3), shared by both bridge implementations. The
// engine publishes the keys it handles in the reply to ui.manifest, resolved for the platform and runtime that hello named
// (src/engine/platform.ts): each command's bindings, the document keys, and the reserved keys that the shell keeps for itself, the system
// or the browser. A press goes to the engine, and the browser's own handling of it is stopped, if and only if it matches a binding of a
// command without shell_action or a document key, matches no reserved key, and no input method is composing with it. The decision is
// synchronous, in the keydown handler, because the browser's default action can only be stopped there; that is why the engine sends the
// lists in advance.
//
// Every other press stays with the browser: typed text reaches the engine as input.text from the bridge's text input, never as input.key;
// Mod with =, +, - and 0 is the browser's page zoom; and the clipboard keys are left to the browser's copy, cut and paste events, which the
// bridges handle. The shell guesses nothing about Ctrl and Command: the engine resolved the manifest's "Ctrl" for the platform.

import type { InputKey, Modifiers, UiManifest } from "../engine/protocol.ts";

/** A key named by `key` (KeyboardEvent.key) or by `code` (KeyboardEvent.code), with the modifiers that must match; one left out matches either. */
export interface KeyEntry {
  readonly key?: string;
  readonly code?: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
}

/** What the engine handles and what the shell keeps, from the reply to ui.manifest. */
export interface KeyData {
  /** The bindings of commands that the engine carries out: those without shell_action. */
  readonly bindings: readonly KeyEntry[];
  /** The keys the engine handles in the document area, with any modifiers. */
  readonly document: readonly KeyEntry[];
  /** The presses the shell keeps for itself, the operating system or the browser, even where a binding or document key matches. */
  readonly reserved: readonly KeyEntry[];
  /** The shortcut labels of the commands the shell may offer, as the platform writes them ("⌘B", "Ctrl+B"), by command identifier. */
  readonly labels: ReadonlyMap<string, readonly string[]>;
}

/** No keys: before the engine sent its manifest, every press stays with the browser. */
export const noKeys: KeyData = { bindings: [], document: [], reserved: [], labels: new Map() };

/** The shell actions this shell carries out (§14.3, §14.5): through the browser's clipboard. */
export const knownShellActions: ReadonlySet<string> = new Set(["copy", "cut", "paste"]);

/** A manifest entry as the reply carries it (src/engine/checks.ts checked it): exactly one of key and code, modifiers as given. */
function entryOf(entry: {
  key?: string | null;
  code?: string | null;
  ctrl?: boolean | null;
  shift?: boolean | null;
  alt?: boolean | null;
  meta?: boolean | null;
}): KeyEntry {
  const result: { -readonly [K in keyof KeyEntry]: KeyEntry[K] } = {};
  if (typeof entry.key === "string") result.key = entry.key;
  if (typeof entry.code === "string") result.code = entry.code;
  for (const modifier of ["ctrl", "shift", "alt", "meta"] as const) {
    const value = entry[modifier];
    if (typeof value === "boolean") result[modifier] = value;
  }
  return result;
}

/**
 * The key data of a manifest. A command with shell_action is the shell's to carry out, through the platform (§14.5): its keys never go to
 * the engine. A shell_action this shell does not know means a command that it neither sends nor offers, so that later manifests can add
 * actions without breaking v1 (§14.3); its labels are left out too.
 */
export function keyDataOf(manifest: Pick<UiManifest, "commands" | "keys">): KeyData {
  const bindings: KeyEntry[] = [];
  const labels = new Map<string, readonly string[]>();
  for (const command of manifest.commands) {
    const action = command.shell_action;
    // One at a time: a manifest's list spread into push() could pass more arguments than a browser allows.
    if (action === undefined || action === null)
      for (const binding of command.bindings) bindings.push(entryOf(binding));
    if (action === undefined || action === null || knownShellActions.has(action)) {
      labels.set(
        command.id,
        command.bindings.map((binding) => binding.label),
      );
    }
  }
  return {
    bindings,
    document: manifest.keys.document.map(entryOf),
    reserved: manifest.keys.reserved.map(entryOf),
    labels,
  };
}

/** The parts of a key press that the decision needs: KeyboardEvent's, or a conformance vector's (§15). */
export interface KeyPress {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /** Whether an input method is composing with the press. */
  readonly composing: boolean;
}

const isAsciiLetterOrDigit = (key: string): boolean => /^[A-Za-z0-9]$/.test(key);

/** ASCII letters in lower case, every other character unchanged: Rust, Qt and JavaScript change the case of other letters differently. */
const foldAscii = (key: string): string => key.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** The lower-case letter or the digit that a code from KeyA to KeyZ or Digit0 to Digit9 names, or null. */
function letterOrDigitOf(code: string): string | null {
  const match = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  if (match === null) return null;
  return (match[1] ?? match[2] ?? "").toLowerCase();
}

/**
 * Whether an entry matches a press, by the one rule for bindings, document keys and reserved keys (§14.3 item 3). A modifier that the entry
 * gives must equal the press's. An entry with `code` matches the press's code. An entry with `key` matches the press's key, ASCII letters
 * without regard to case and every other character exactly; where they differ, the entry's key is an ASCII letter or digit and the press's
 * is not, and the press does not hold Ctrl and Alt together (AltGr on Windows), the letter or digit of the press's code counts instead,
 * so that Arabic, Hebrew, Cyrillic and Greek layouts reach the same shortcuts and a character that AltGr types stays text.
 */
export function matches(entry: KeyEntry, press: KeyPress): boolean {
  if (
    (entry.ctrl !== undefined && entry.ctrl !== press.ctrlKey) ||
    (entry.shift !== undefined && entry.shift !== press.shiftKey) ||
    (entry.alt !== undefined && entry.alt !== press.altKey) ||
    (entry.meta !== undefined && entry.meta !== press.metaKey)
  ) {
    return false;
  }
  if (entry.code !== undefined) return entry.code === press.code;
  if (entry.key === undefined) return false;
  const wanted = foldAscii(entry.key);
  if (wanted === foldAscii(press.key)) return true;
  if (!isAsciiLetterOrDigit(entry.key) || isAsciiLetterOrDigit(press.key) || (press.ctrlKey && press.altKey))
    return false;
  return letterOrDigitOf(press.code) === wanted;
}

/** Whether the shell sends a press to the engine as input.key (§14.3 item 2). */
export function sendsKey(press: KeyPress, keys: KeyData): boolean {
  if (press.composing) return false;
  const matching = (entry: KeyEntry) => matches(entry, press);
  if (keys.reserved.some(matching)) return false;
  return keys.bindings.some(matching) || keys.document.some(matching);
}

/** The parts of a KeyboardEvent the bridges hand to decideKey. */
export interface KeyEvent {
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

export function modifiersOf(press: Pick<KeyEvent, "shiftKey" | "ctrlKey" | "altKey" | "metaKey">): Modifiers {
  return { shift: press.shiftKey, ctrl: press.ctrlKey, alt: press.altKey, meta: press.metaKey };
}

/**
 * The input.key to send for a keydown (without doc_id), or null when the press stays with the browser; the bridge stops the browser's
 * default action exactly when it sends one. An input method composes with a press while isComposing is set, and with the press that ends a
 * composition, for which WebKit reports keyCode 229 instead.
 */
export function decideKey(event: KeyEvent, keys: KeyData): Omit<InputKey, "doc_id"> | null {
  // Field by field: a KeyboardEvent's fields are getters of its prototype, which spreading it would not copy.
  const press: KeyPress = {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    composing: event.isComposing || event.keyCode === 229,
  };
  if (!sendsKey(press, keys)) return null;
  return { key: event.key, code: event.code, modifiers: modifiersOf(event), repeat: event.repeat, composing: false };
}
