// The accessibility mirror, version 0 (ADR-0014 §6, ADR-0020 §4): a DOM copy of the engine's accessibility tree (spec §6.6) that people
// never see but screen readers read, because the pages themselves are pixels on a canvas. Headings, paragraphs, lists and tables become
// the HTML elements with those meanings, built with safe DOM APIs only (no HTML from strings); the editable text becomes the input
// bridge's element, which holds the engine's text and caret, so that a screen reader follows the engine's caret there (the caret-sync
// prototype). a11y.update replaces changed nodes in place, and leaves the bridge's element where it is so it never loses focus.
//
// The tree comes from the engine and may be shaped by a hostile document, so the mirror nests elements only MAX_MIRROR_DEPTH levels deep:
// below that, nodes get no elements of their own, and their text goes into the deepest element, one line per node in reading order
// (#visitBelow). Screen-reader users still hear every word in order and can still reach the editable text; they lose only the structure
// below that level (headings, list items and table cells become plain lines), which no real document reaches, and which a screen reader
// could not convey usefully that deep anyway. No work is a recursion deeper than that limit, so no tree can exhaust the call stack, and
// every step takes time in proportion to what it touches: building visits each node once; forgetting a replaced subtree visits only that
// subtree; a change below the limit costs time in proportion to its own size; and the flattened text of a node on the deepest level is
// rebuilt at most once per update for the changes below it. Nothing but the engine's message limit (16 MiB, spec §13) bounds the size of a
// tree yet, so a very large tree still takes time in proportion to its size.
//
// While no document is open the input bridge's element is inert, out of the tab order and the accessibility tree, so that it is never a
// text box with no name and no text. The mirror is also marked translate="no": a browser's page translation would otherwise send the
// document's text to a translation service, which is why the input bridges switch off spell checking too.

import type { A11yCaret, A11yNode, A11yTree, A11yUpdate } from "../engine/protocol.ts";
import type { InputBridge } from "../input/bridge.ts";

/**
 * How many levels of nodes get elements of their own, counting the document node as level 1. The desktop shell reads trees to the same
 * depth (its kMaxTreeDepth, src/engine/protocol.h in bayan-desktop), but refuses a deeper one instead of flattening it.
 */
export const MAX_MIRROR_DEPTH = 64;

/** A node below the deepest level, and where it sits: its parent and its index among the parent's children. */
interface Placed {
  readonly node: A11yNode;
  readonly parent: A11yNode;
  readonly index: number;
}

export class AccessibilityMirror {
  readonly #container: HTMLElement;
  readonly #bridge: InputBridge;
  readonly #elements = new Map<number, HTMLElement>();
  /** The nodes on the deepest level that have nodes below them, by identifier, each with the identifiers of the nodes below it. */
  readonly #deep = new Map<number, { readonly node: A11yNode; readonly below: number[] }>();
  /** Every node below the deepest level, by identifier, with the identifier of the deepest-level node whose element holds its text. */
  readonly #below = new Map<number, { readonly node: A11yNode; readonly owner: number }>();
  /** Where each node below the deepest level sits, so that a change can replace it there instead of searching for it. */
  #places = new WeakMap<A11yNode, { readonly parent: A11yNode; readonly index: number }>();
  /** While an update is applied: the deepest-level nodes whose flattened text is rebuilt once all its changes are in. */
  #stale: Set<number> | null = null;
  #editable: A11yNode | undefined;
  #caret: A11yCaret | null = null;

  constructor(container: HTMLElement, bridge: InputBridge) {
    this.#container = container;
    this.#bridge = bridge;
    container.setAttribute("translate", "no");
  }

  /** The editable node, if the tree has one: the input bridge needs its character boxes. */
  get editable(): A11yNode | undefined {
    return this.#editable;
  }

  /** Builds the mirror from the reply to query.a11y. */
  setTree(tree: A11yTree): void {
    this.#forgetAll();
    const root = this.#build(tree.root, 1);
    this.#container.replaceChildren(root);
    if (!this.#container.contains(this.#bridge.element)) {
      // A document without editable text still needs a place for keyboard focus.
      this.#container.append(this.#bridge.element);
    }
    this.#bridge.element.inert = false;
    this.#setCaret(tree.caret);
  }

  /** Applies a11y.update: each change replaces the node with the same identifier, children included. */
  update(update: A11yUpdate): void {
    const stale = new Set<number>();
    this.#stale = stale;
    try {
      for (const change of update.changes) {
        const below = this.#below.get(change.node.id);
        if (below !== undefined) {
          this.#changeBelow(below, change.node);
          continue;
        }
        const old = this.#elements.get(change.node.id);
        if (old === undefined) continue;
        // The bridge's element sits below the deepest level when the editable text does; what replaces it is built on that level.
        const level = Math.min(this.#levelOf(old), MAX_MIRROR_DEPTH);
        this.#forget(old);
        const replacement = this.#build(change.node, level);
        if (replacement !== old) old.replaceWith(replacement);
      }
    } finally {
      this.#stale = null;
    }
    for (const id of stale) {
      const owner = this.#deep.get(id);
      const element = this.#elements.get(id);
      if (owner === undefined || element === undefined) continue;
      this.#forget(element);
      element.replaceWith(this.#build(owner.node, MAX_MIRROR_DEPTH));
    }
    this.#setCaret(update.caret);
  }

  /** Clears the mirror, for a new session: no document is open, so the bridge's element holds no text of one and takes no focus. */
  clear(): void {
    this.#forgetAll();
    this.#caret = null;
    this.#container.replaceChildren(this.#bridge.element);
    this.#bridge.sync({ name: "", text: "", caret: null });
    this.#bridge.element.inert = true;
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

  #forgetAll(): void {
    this.#elements.clear();
    this.#deep.clear();
    this.#below.clear();
    this.#places = new WeakMap();
    this.#editable = undefined;
  }

  /**
   * Forgets the elements of a subtree that is about to be replaced, and the nodes below its deepest-level nodes, in time proportional to
   * the subtree: it visits only the subtree's own elements and the lists of nodes below them.
   */
  #forget(element: HTMLElement): void {
    for (const candidate of [element, ...element.querySelectorAll<HTMLElement>("[data-node-id]")]) {
      const id = Number(candidate.dataset["nodeId"]);
      if (this.#elements.get(id) !== candidate) continue;
      this.#elements.delete(id);
      const owner = this.#deep.get(id);
      if (owner === undefined) continue;
      for (const below of owner.below) {
        if (this.#below.get(below)?.owner === id) this.#below.delete(below);
      }
      this.#deep.delete(id);
      this.#stale?.delete(id);
    }
  }

  /**
   * A change of a node below the deepest level: the node is replaced where it sits, its new subtree is recorded, and the flattened text that
   * holds it is marked for rebuilding at the end of the update, so that the change costs time in proportion to its own size.
   */
  #changeBelow(below: { readonly node: A11yNode; readonly owner: number }, node: A11yNode): void {
    const place = this.#places.get(below.node);
    const siblings = place?.parent.children;
    if (place === undefined || siblings === undefined || siblings === null || siblings[place.index] !== below.node)
      return;
    siblings[place.index] = node;
    this.#visitBelow(below.owner, [{ node, parent: place.parent, index: place.index }], null);
    if (below.node.editable === true && node.editable === true) {
      // The editable text is the bridge's element, which shows it: nothing to rebuild.
      this.#editableElement(node);
      return;
    }
    this.#stale?.add(below.owner);
  }

  /** The level of a node's element: 1 for the document node's, the container's child. */
  #levelOf(element: HTMLElement): number {
    let level = 0;
    for (
      let current: Element | null = element;
      current !== null && current !== this.#container;
      current = current.parentElement
    ) {
      level += 1;
    }
    return level;
  }

  /** The element of `node` on `level` (1 to MAX_MIRROR_DEPTH), with its children's elements, or their flattened text on the last level. */
  #build(node: A11yNode, level: number): HTMLElement {
    if (node.editable === true) return this.#editableElement(node);
    const element = this.#elementFor(node);
    element.dataset["nodeId"] = String(node.id);
    if (node.name !== undefined && node.name !== null && node.role === "document") {
      element.setAttribute("aria-label", node.name);
    }
    if (node.text !== undefined && node.text !== null) element.append(node.text);
    const children = node.children ?? [];
    if (level < MAX_MIRROR_DEPTH) {
      for (const child of children) element.append(this.#build(child, level + 1));
    } else if (children.length > 0) {
      this.#deep.set(node.id, { node, below: [] });
      this.#visitBelow(
        node.id,
        children.map((child, index) => ({ node: child, parent: node, index })),
        element,
      );
    }
    this.#elements.set(node.id, element);
    return element;
  }

  /** The bridge's element stands for the editable node, wherever it is in the tree. */
  #editableElement(node: A11yNode): HTMLElement {
    this.#editable = node;
    const element = this.#bridge.element;
    element.dataset["nodeId"] = String(node.id);
    this.#elements.set(node.id, element);
    return element;
  }

  /**
   * Visits nodes below the deepest-level node `ownerId`, from `start` down, in reading order: records each node and where it sits and, given
   * the owner's element `into`, appends one line per node that has text and the bridge's element where the editable node is (whose children
   * are not shown, as above the limit). A loop with a list of nodes still to visit rather than a recursion, so that no depth exhausts the
   * call stack; each node is visited once, so that even a tree whose nodes repeat (which JSON cannot express, but a structured clone could)
   * cannot make it loop.
   */
  #visitBelow(ownerId: number, start: readonly Placed[], into: HTMLElement | null): void {
    const owner = this.#deep.get(ownerId);
    if (owner === undefined) return;
    const visited = new Set<A11yNode>();
    const pending = [...start].reverse();
    while (pending.length > 0) {
      const { node, parent, index } = pending.pop() as Placed;
      if (visited.has(node)) continue;
      visited.add(node);
      if (this.#below.get(node.id)?.owner !== ownerId) owner.below.push(node.id);
      this.#below.set(node.id, { node, owner: ownerId });
      this.#places.set(node, { parent, index });
      if (node.editable === true) {
        if (into !== null) into.append(this.#editableElement(node));
        continue;
      }
      if (into !== null && node.text !== undefined && node.text !== null && node.text !== "") {
        const line = document.createElement("div");
        line.append(node.text);
        into.append(line);
      }
      const children = node.children ?? [];
      for (let child = children.length - 1; child >= 0; child -= 1) {
        pending.push({ node: children[child] as A11yNode, parent: node, index: child });
      }
    }
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
      case "table": {
        // An explicit role, because Firefox's heuristics otherwise take a table it cannot see for a layout table: Orca then neither
        // counts it nor finds it with its table navigation (WEB-002 report).
        const element = document.createElement("table");
        element.setAttribute("role", "table");
        return element;
      }
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
