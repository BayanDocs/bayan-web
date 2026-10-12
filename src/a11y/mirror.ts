// The accessibility mirror, version 0 (ADR-0014 §6, ADR-0020 §4): a DOM copy of the engine's accessibility tree (spec §6.6) that people
// never see but screen readers read, because the pages themselves are pixels on a canvas. Headings, paragraphs, lists and tables become
// the HTML elements with those meanings, built with safe DOM APIs only (no HTML from strings); the editable text becomes the input
// bridge's element, which holds the engine's text and caret, so that a screen reader follows the engine's caret there (the caret-sync
// prototype). a11y.update replaces changed nodes in place, and leaves the bridge's element where it is so it never loses focus.

import type { A11yCaret, A11yNode, A11yTree, A11yUpdate } from "../engine/protocol.ts";
import type { InputBridge } from "../input/bridge.ts";

export class AccessibilityMirror {
  readonly #container: HTMLElement;
  readonly #bridge: InputBridge;
  readonly #elements = new Map<number, HTMLElement>();
  #editable: A11yNode | undefined;
  #caret: A11yCaret | null = null;

  constructor(container: HTMLElement, bridge: InputBridge) {
    this.#container = container;
    this.#bridge = bridge;
  }

  /** The editable node, if the tree has one: the input bridge needs its character boxes. */
  get editable(): A11yNode | undefined {
    return this.#editable;
  }

  /** Builds the mirror from the reply to query.a11y. */
  setTree(tree: A11yTree): void {
    this.#elements.clear();
    this.#editable = undefined;
    const root = this.#build(tree.root);
    this.#container.replaceChildren(root);
    if (!this.#container.contains(this.#bridge.element)) {
      // A document without editable text still needs a place for keyboard focus.
      this.#container.append(this.#bridge.element);
    }
    this.#setCaret(tree.caret);
  }

  /** Applies a11y.update: each change replaces the node with the same identifier, children included. */
  update(update: A11yUpdate): void {
    for (const change of update.changes) {
      const old = this.#elements.get(change.node.id);
      if (old === undefined) continue;
      this.#forget(old);
      const replacement = this.#build(change.node);
      if (replacement !== old) old.replaceWith(replacement);
    }
    this.#setCaret(update.caret);
  }

  /** Clears the mirror, for a new session. */
  clear(): void {
    this.#elements.clear();
    this.#editable = undefined;
    this.#caret = null;
    this.#container.replaceChildren(this.#bridge.element);
  }

  #setCaret(caret: A11yCaret | null): void {
    this.#caret = caret;
    const node = this.#editable;
    if (node === undefined) return;
    this.#bridge.sync({
      name: node.name ?? "",
      text: node.text ?? "",
      caret: this.#caret !== null && this.#caret.node === node.id ? this.#caret.offset : null,
    });
  }

  /** Forgets the elements of a subtree that is about to be replaced. */
  #forget(element: HTMLElement): void {
    for (const [id, candidate] of this.#elements) {
      if (candidate === element || element.contains(candidate)) this.#elements.delete(id);
    }
  }

  #build(node: A11yNode): HTMLElement {
    if (node.editable === true) {
      this.#editable = node;
      const element = this.#bridge.element;
      element.dataset["nodeId"] = String(node.id);
      this.#elements.set(node.id, element);
      return element;
    }
    const element = this.#elementFor(node);
    element.dataset["nodeId"] = String(node.id);
    if (node.name !== undefined && node.name !== null && node.role === "document") {
      element.setAttribute("aria-label", node.name);
    }
    if (node.text !== undefined && node.text !== null) element.append(node.text);
    for (const child of node.children ?? []) element.append(this.#build(child));
    this.#elements.set(node.id, element);
    return element;
  }

  #elementFor(node: A11yNode): HTMLElement {
    switch (node.role) {
      case "document": {
        const element = document.createElement("div");
        element.setAttribute("role", "document");
        return element;
      }
      case "heading": {
        const level = Math.min(9, Math.max(1, node.level ?? 1));
        if (level <= 6) return document.createElement(`h${level}`);
        const element = document.createElement("div");
        element.setAttribute("role", "heading");
        element.setAttribute("aria-level", String(level));
        return element;
      }
      case "paragraph":
        return document.createElement("p");
      case "list": {
        // An explicit role, because Safari drops the list role of a list whose markers are hidden.
        const element = document.createElement("ul");
        element.setAttribute("role", "list");
        return element;
      }
      case "list_item":
        return document.createElement("li");
      case "table":
        return document.createElement("table");
      case "row":
        return document.createElement("tr");
      case "column_header": {
        const element = document.createElement("th");
        element.scope = "col";
        return element;
      }
      case "cell":
        return document.createElement("td");
      default:
        // A role a newer engine added: keep its text readable rather than lose it.
        return document.createElement("div");
    }
  }
}
