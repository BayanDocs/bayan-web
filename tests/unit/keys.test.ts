import { describe, expect, it } from "vitest";
import { decideKey, isApplePlatform, type KeyPress, manifestShortcuts, parseShortcut } from "../../src/input/keys.ts";

function press(key: string, changes: Partial<KeyPress> = {}): KeyPress {
  return {
    key,
    code: "",
    keyCode: 0,
    isComposing: false,
    repeat: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...changes,
  };
}

const shortcuts = manifestShortcuts([
  { id: "format.bold.toggle", label: "Bold", shortcut: "Ctrl+B" },
  { id: "edit.undo", label: "Undo", shortcut: "Ctrl+Z" },
  { id: "none", label: "No shortcut" },
]);

describe("which key presses go to the engine", () => {
  it("sends editing and navigation keys and stops the browser's own action", () => {
    for (const key of ["Backspace", "Delete", "Enter", "ArrowLeft", "ArrowRight", "Home", "End", "PageDown"]) {
      const decision = decideKey(press(key), shortcuts, false);
      expect(decision?.preventDefault, key).toBe(true);
      expect(decision?.message.key).toBe(key);
    }
  });

  it("leaves Tab to the browser, so keyboard focus can always leave the document", () => {
    expect(decideKey(press("Tab"), shortcuts, false)).toBeNull();
  });

  it("never sends printable keys: their text arrives as input.text", () => {
    expect(decideKey(press("a"), shortcuts, false)).toBeNull();
    expect(decideKey(press("A", { shiftKey: true }), shortcuts, false)).toBeNull();
  });

  it("leaves every key of an input method's composition to the input method", () => {
    expect(decideKey(press("Backspace", { isComposing: true }), shortcuts, false)).toBeNull();
    // WebKit reports keyCode 229 for the key that ends a composition, after compositionend, with isComposing false.
    expect(decideKey(press("Enter", { keyCode: 229 }), shortcuts, false)).toBeNull();
  });

  it("sends the UI manifest's shortcuts with their modifiers: Ctrl elsewhere, Command on Apple systems", () => {
    const ctrlB = decideKey(press("b", { ctrlKey: true }), shortcuts, false);
    expect(ctrlB?.message).toMatchObject({
      key: "b",
      modifiers: { ctrl: true, meta: false, shift: false, alt: false },
    });
    expect(decideKey(press("b", { metaKey: true }), shortcuts, false)).toBeNull();
    expect(decideKey(press("b", { metaKey: true }), shortcuts, true)?.message.modifiers).toMatchObject({ meta: true });
    expect(decideKey(press("b", { ctrlKey: true }), shortcuts, true)).toBeNull();
    expect(decideKey(press("B", { ctrlKey: true, shiftKey: true }), shortcuts, false)).toBeNull();
  });

  it("leaves the clipboard shortcuts to the browser, so its copy, cut and paste events fire", () => {
    for (const key of ["c", "x", "v"]) expect(decideKey(press(key, { ctrlKey: true }), shortcuts, false)).toBeNull();
  });
});

describe("manifest shortcuts", () => {
  it("parses modifier combinations and refuses forms it does not know", () => {
    expect(parseShortcut("Ctrl+Shift+B")).toEqual({ key: "b", primary: true, shift: true, alt: false });
    expect(parseShortcut("Alt+F4")).toEqual({ key: "F4", primary: false, shift: false, alt: true });
    expect(parseShortcut("Hyper+B")).toBeNull();
    expect(parseShortcut("Ctrl+")).toBeNull();
  });

  it("recognizes Apple platforms", () => {
    expect(isApplePlatform("MacIntel")).toBe(true);
    expect(isApplePlatform("iPhone")).toBe(true);
    expect(isApplePlatform("Linux x86_64")).toBe(false);
    expect(isApplePlatform("Win32")).toBe(false);
  });
});
