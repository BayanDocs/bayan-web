// The accessibility mirror, version 0 (ADR-0014 §6, ADR-0020 §4): a DOM copy of the engine's accessibility tree (spec §6.6) that people
// never see but screen readers read, because the pages themselves are pixels on a canvas. Headings, paragraphs, lists and tables become
// the HTML elements with those meanings, built with safe DOM APIs only (no HTML from strings); the editable text becomes the input
// bridge's element, which holds the engine's text and caret, so that a screen reader follows the engine's caret there (the caret-sync
// prototype). a11y.update replaces changed nodes in place, and leaves the bridge's element where it is so it never loses focus.
//
// The tree comes from the engine and may be shaped by a hostile document, so the mirror nests elements only MAX_MIRROR_DEPTH levels deep:
// below that, nodes get no elements of their own, and their text goes into the deepest element, one line per node in reading order
// (#flatten). Screen-reader users still hear every word in order and can still reach the editable text; they lose only the structure
// below that level (headings, list items and table cells become plain lines), which no real document reaches, and which a screen reader
// could not convey usefully that deep anyway. Building and flattening take time proportional to the number of nodes, never a recursion
// as deep as the tree, so a deep tree can neither exhaust the call stack nor freeze the page. The mirror is also marked translate="no":
// a browser's page translation would otherwise send the document's text to a translation service, which is why the input bridges switch
// off spell checking too.

import type { A11yCaret, A11yNode, A11yTree, A11yUpdate } from "../engine/protocol.ts";
import type { InputBridge } from "../input/bridge.ts";

/**
 * How many levels of nodes get elements of their own, counting the document node as level 1: as deep as the desktop shell reads the tree
 * (its kMaxTreeDepth, src/engine/protocol.h in bayan-desktop).
 */
export const MAX_MIRROR_DEPTH = 64;

/**
 * A copy of `root` in which the node below it with `replacement`'s identifier is `replacement`, copying only the nodes on the way down to
 * it; `root` itself if there is no such node. Iterative, because the subtree may be deeper than the call stack.
 */
function withReplaced(root: A11yNode, replacement: A11yNode): A11yNode {
  // Each node's parent as first found on the way down; a node seen before is not visited again, so the links form a tree and lead back
  // to the root even if nodes repeat (which JSON cannot express, but a structured clone could).
  const parents = new Map<A11yNode, { parent: A11yNode; index: number }>();
  const visited = new Set<A11yNode>([root]);
  const pending: A11yNode[] = [root];
  let found: A11yNode | undefined;
  while (pending.length > 0 && found === undefined) {
    const node = pending.pop() as A11yNode;
    for (const [index, child] of (node.children ?? []).entries()) {
      if (visited.has(child)) continue;
      visited.add(child);
      parents.set(child, { parent: node, index });
      if (child.id === replacement.id) {
        found = child;
        break;
      }
      pending.push(child);
    }
  }
  if (found === undefined) return root;
  let copy = replacement;
  for (let link = parents.get(found); link !== undefined; link = parents.get(link.parent)) {
    const children = [...(link.parent.children ?? [])];
    children[link.index] = copy;
    copy = { ...link.parent, children };
  }
  return copy;
}

export class AccessibilityMirror {
  readonly #container: HTMLElement;
  readonly #bridge: InputBridge;
  readonly #elements = new Map<number, HTMLElement>();
  /** The nodes on the deepest level that have nodes below them, by identifier: their flattened text is rebuilt from them on a change. */
  readonly #deep = new Map<number, A11yNode>();
  /** For every node below the deepest level, the identifier of the node on that level whose element holds its text. */
  readonly #deepOwners = new Map<number, number>();
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
    this.#setCaret(tree.caret);
  }

  /** Applies a11y.update: each change replaces the node with the same identifier, children included. */
  update(update: A11yUpdate): void {
    for (const change of update.changes) {
      const id = change.node.id;
      // A node below the deepest level: its owner's copy of the subtree changes too, so that a later rebuild shows the change.
      const ownerId = this.#deepOwners.get(id);
      const owner = ownerId === undefined ? undefined : this.#deep.get(ownerId);
      if (ownerId !== undefined && owner !== undefined) this.#deep.set(ownerId, withReplaced(owner, change.node));
      const old = this.#elements.get(id);
      if (old !== undefined) {
        // Elements below the deepest level (the bridge's, when the editable text is that deep) are rebuilt on the deepest level.
        const level = Math.min(this.#levelOf(old), MAX_MIRROR_DEPTH);
        this.#forget(old);
        const replacement = this.#build(change.node, level);
        if (replacement !== old) old.replaceWith(replacement);
      } else if (ownerId !== undefined) {
        // A node that has no element of its own: rebuild the flattened text that holds it.
        const node = this.#deep.get(ownerId);
        const element = this.#elements.get(ownerId);
        if (node === undefined || element === undefined) continue;
        this.#forget(element);
        element.replaceWith(this.#build(node, MAX_MIRROR_DEPTH));
      }
    }
    this.#setCaret(update.caret);
  }

  /** Clears the mirror, for a new session: no document is open, so the bridge's element holds no text of one either. */
  clear(): void {
    this.#forgetAll();
    this.#caret = null;
    this.#container.replaceChildren(this.#bridge.element);
    this.#bridge.sync({ name: "", text: "", caret: null });
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
    this.#deepOwners.clear();
    this.#editable = undefined;
  }

  /** Forgets the elements of a subtree that is about to be replaced, and the flattened text below them. */
  #forget(element: HTMLElement): void {
    for (const [id, candidate] of this.#elements) {
      if (candidate !== element && !element.contains(candidate)) continue;
      this.#elements.delete(id);
      if (this.#deep.delete(id)) {
        for (const [below, owner] of this.#deepOwners) {
          if (owner === id) this.#deepOwners.delete(below);
        }
      }
    }
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
      this.#deep.set(node.id, node);
      this.#flatten(node, element);
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
   * Appends the text of every node below `owner`, a node on the deepest level, to its element `into`: one line per node that has text, in
   * reading order, and the bridge's element where the editable node is. A loop with a list of nodes still to visit rather than a recursion,
   * so that no depth exhausts the call stack; and each node is visited once, so that even a tree whose nodes repeat (which JSON cannot
   * express, but a structured clone could) cannot make it loop.
   */
  #flatten(owner: A11yNode, into: HTMLElement): void {
    const visited = new Set<A11yNode>([owner]);
    const pending = [...(owner.children ?? [])].reverse();
    while (pending.length > 0) {
      const node = pending.pop() as A11yNode;
      if (visited.has(node)) continue;
      visited.add(node);
      this.#deepOwners.set(node.id, owner.id);
      if (node.editable === true) {
        into.append(this.#editableElement(node));
      } else if (node.text !== undefined && node.text !== null && node.text !== "") {
        const line = document.createElement("div");
        line.append(node.text);
        into.append(line);
      }
      const children = node.children ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index] as A11yNode);
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
