import { describe, expect, it } from "vitest";
import type { UiManifest } from "../../src/engine/protocol.ts";
import { decideKey, type KeyEvent, type KeyPress, keyDataOf, matches, noKeys, sendsKey } from "../../src/input/keys.ts";

// The key decision of engine protocol §14.3 (src/input/keys.ts). The conformance vectors of keys.json run against it in
// conformance.test.ts; these tests cover what the vectors leave out: how the manifest becomes key data, and the keydown handler's view.

const press = (changes: Partial<KeyPress>): KeyPress => ({
  key: "b",
  code: "KeyB",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  composing: false,
  ...changes,
});

const event = (changes: Partial<KeyEvent>): KeyEvent => ({
  key: "b",
  code: "KeyB",
  keyCode: 66,
  isComposing: false,
  repeat: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...changes,
});

const binding = (key: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean }, label: string) => ({
  key,
  ctrl: modifiers.ctrl ?? false,
  shift: modifiers.shift ?? false,
  alt: false,
  meta: modifiers.meta ?? false,
  label,
});

/** A manifest like the engine's stub for Windows in a browser, cut down to what the tests need. */
const manifest: Pick<UiManifest, "commands" | "keys"> = {
  commands: [
    { id: "format.bold.toggle", label: "Bold", bindings: [binding("b", { ctrl: true }, "Ctrl+B")] },
    { id: "edit.copy", label: "Copy", bindings: [binding("c", { ctrl: true }, "Ctrl+C")], shell_action: "copy" },
    {
      id: "edit.paste.special",
      label: "Paste Special",
      bindings: [binding("v", { ctrl: true, shift: true }, "Ctrl+Shift+V")],
      shell_action: "paste_special",
    },
  ],
  keys: {
    document: [{ key: "Backspace" }, { key: "ArrowLeft" }],
    reserved: [
      { key: "Tab", ctrl: false, alt: false, meta: false },
      { key: "=", ctrl: true, shift: false, alt: false, meta: false },
      { code: "KeyF", alt: true, ctrl: false, meta: false, shift: false },
    ],
  },
};
const keys = keyDataOf(manifest);

describe("matching (spec §14.3 item 3)", () => {
  it("compares ASCII letters without regard to case, and every other character exactly", () => {
    expect(matches({ key: "b" }, press({ key: "B" }))).toBe(true);
    expect(matches({ key: "B" }, press({ key: "b" }))).toBe(true);
    // Rust, Qt and JavaScript change the case of other letters differently, so they are compared as they are.
    expect(matches({ key: "é" }, press({ key: "É", code: "Digit2" }))).toBe(false);
  });

  it("gives every modifier an entry names, and leaves the others free", () => {
    expect(matches({ key: "b", ctrl: true }, press({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matches({ key: "b", ctrl: true, shift: false }, press({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matches({ key: "b", ctrl: true }, press({ ctrlKey: false }))).toBe(false);
  });

  it("matches an entry with code by the key's position only", () => {
    expect(matches({ code: "KeyF", alt: true }, press({ key: "ب", code: "KeyF", altKey: true }))).toBe(true);
    expect(matches({ code: "KeyF" }, press({ key: "f", code: "KeyG" }))).toBe(false);
  });

  it("falls back to the position for a key that types no ASCII letter or digit, but not for one AltGr types", () => {
    // Russian: the key that types "и" sits where B is on a US keyboard.
    expect(matches({ key: "b", ctrl: true }, press({ key: "и", code: "KeyB", ctrlKey: true }))).toBe(true);
    // French: Ctrl with the key that types "é" is Ctrl+2.
    expect(matches({ key: "2", ctrl: true }, press({ key: "é", code: "Digit2", ctrlKey: true }))).toBe(true);
    // A press that types an ASCII letter keeps its character: French Z sits where W is.
    expect(matches({ key: "w", ctrl: true }, press({ key: "z", code: "KeyW", ctrlKey: true }))).toBe(false);
    // Ctrl and Alt together are AltGr on Windows: the character it types stays text.
    expect(
      matches({ key: "e", ctrl: true, alt: true }, press({ key: "€", code: "KeyE", ctrlKey: true, altKey: true })),
    ).toBe(false);
    // An entry that is not an ASCII letter or digit never falls back, nor does a code that names none.
    expect(matches({ key: "=", ctrl: true }, press({ key: "ё", code: "Equal", ctrlKey: true }))).toBe(false);
    expect(matches({ key: "b", ctrl: true }, press({ key: "и", code: "", ctrlKey: true }))).toBe(false);
  });
});

describe("the decision (spec §14.3 item 2)", () => {
  it("sends a binding of a command without shell_action and a document key with any modifiers", () => {
    expect(sendsKey(press({ ctrlKey: true }), keys)).toBe(true);
    expect(sendsKey(press({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true, ctrlKey: true }), keys)).toBe(true);
    expect(sendsKey(press({}), keys)).toBe(false);
  });

  it("never sends the keys of a command the shell carries out, whether it knows the action or not", () => {
    expect(sendsKey(press({ key: "c", code: "KeyC", ctrlKey: true }), keys)).toBe(false);
    expect(sendsKey(press({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true }), keys)).toBe(false);
  });

  it("keeps a reserved press even where a binding or document key matches it", () => {
    const withTab = keyDataOf({
      ...manifest,
      keys: { document: [{ key: "Tab" }], reserved: manifest.keys.reserved },
    });
    expect(sendsKey(press({ key: "Tab", code: "Tab" }), withTab)).toBe(false);
    expect(sendsKey(press({ key: "=", code: "Equal", ctrlKey: true }), keys)).toBe(false);
  });

  it("leaves every press an input method composes with to it", () => {
    expect(sendsKey(press({ key: "Backspace", code: "Backspace", composing: true }), keys)).toBe(false);
  });

  it("sends nothing before the engine sent its manifest", () => {
    expect(sendsKey(press({ ctrlKey: true }), noKeys)).toBe(false);
    expect(sendsKey(press({ key: "Backspace", code: "Backspace" }), noKeys)).toBe(false);
  });
});

describe("the keydown handler's view", () => {
  it("turns a press it sends into input.key with the key, its position and all four modifiers", () => {
    expect(decideKey(event({ ctrlKey: true, repeat: true }), keys)).toEqual({
      key: "b",
      code: "KeyB",
      modifiers: { shift: false, ctrl: true, alt: false, meta: false },
      repeat: true,
      composing: false,
    });
    expect(decideKey(event({}), keys)).toBeNull();
  });

  it("treats isComposing and WebKit's keyCode 229 as composition", () => {
    const backspace = { key: "Backspace", code: "Backspace" };
    expect(decideKey(event(backspace), keys)).not.toBeNull();
    expect(decideKey(event({ ...backspace, isComposing: true }), keys)).toBeNull();
    expect(decideKey(event({ ...backspace, keyCode: 229 }), keys)).toBeNull();
  });
});

describe("the manifest's labels (spec §14.3 item 1)", () => {
  it("keeps the labels of the commands the shell may offer, as the engine formatted them", () => {
    expect(keys.labels.get("format.bold.toggle")).toEqual(["Ctrl+B"]);
    expect(keys.labels.get("edit.copy")).toEqual(["Ctrl+C"]);
    // A shell_action this shell does not know: the command is neither sent nor offered.
    expect(keys.labels.has("edit.paste.special")).toBe(false);
  });
});
