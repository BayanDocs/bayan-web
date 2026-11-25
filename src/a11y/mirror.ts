// The accessibility mirror (ADR-0014 §6, ADR-0020 §4): a DOM copy of the engine's accessibility tree (spec §6.6) that people never see
// but screen readers read, because the pages themselves are pixels on a canvas. Headings, paragraphs, lists and tables become the HTML
// elements with those meanings, built with safe DOM APIs only (no HTML from strings); the editable text becomes the input bridge's
// element, which holds the engine's text and caret, so that a screen reader follows the engine's caret there (the caret-sync prototype).
// a11y.update replaces changed nodes in place, and leaves the bridge's element where it is so it never loses focus.
//
// Protocol v1 (spec §14.7 item 1). The engine keeps every tree within the limits of 64 levels and 200,000 nodes per message, flattening
// what lies deeper into the text of the node at level 64, so the mirror builds every node it receives as an element of its own, after
// checking the tree (tree.ts): a tree beyond the limits, or one that contradicts itself or what the mirror holds, breaks the protocol, and
// the mirror reports it instead of building anything (onViolation), so that the app stops using the engine. Where a node's children do
// not all fit into one message, the node holds a run of them and says how many it has; the mirror shows the node with all its children
// by loading the parts it lacks with query.a11y { node, children: { start, count } }, one part at a time, as soon as it learns of them.
// A part fills a gap next to the children the mirror holds and never replaces one, so loading never moves the element that has focus.
//
// A faulty engine cannot keep the mirror loading: each answer must hold the child its range starts with (so every answer adds to the
// node's fixed number of children), no more than the range asked for, the node's unchanged number of children and only identifiers new
// to the mirror; anything else breaks the protocol. A part that the engine refuses is not asked for again until the node changes. And the
// mirror loads no more parts once it holds MAX_MIRROR_NODES nodes, the shell's own bound on the elements it builds.
//
// Every step takes time in proportion to what it touches: building visits each node once, a replacement forgets only the subtree it
// replaces, and a part is inserted next to its neighbours, found by binary search. No work recurses deeper than the tree's 64 levels.
//
// While no document is open the input bridge's element is inert, out of the tab order and the accessibility tree, so that it is never a
// text box with no name and no text. The mirror is also marked translate="no": a browser's page translation would otherwise send the
// document's text to a translation service, which is why the input bridges switch off spell checking too.

import type { A11yCaret, A11yNode, A11yTree, A11yUpdate, ChildRange } from "../engine/protocol.ts";
import type { InputBridge } from "../input/bridge.ts";
import { type ChildRun, checkTree, childRun, type Gap, gapsOf } from "./tree.ts";

/**
 * The most nodes the mirror holds before it stops loading parts: five times what one message may hold. Beyond it a document's remaining
 * parts stay unloaded rather than make the browser build millions of elements (a follow-up decides loading them as the reader moves).
 */
export const MAX_MIRROR_NODES = 1_000_000;

/** A node of the mirror. */
interface Mirrored {
  readonly id: number;
  readonly element: HTMLElement;
  /** Its level in the document's tree: 1 for the document node. */
  readonly level: number;
  readonly parent: Mirrored | null;
  /** Its index among its parent's children. */
  readonly index: number;
  /** The children it holds, by index, in ascending order. */
  readonly children: Mirrored[];
  /** How many children it has; more than it holds while parts are missing. */
  readonly count: number;
  /** The engine refused to load one of its parts: none is asked for again until the node changes. */
  refused: boolean;
}

export interface MirrorOptions {
  /** Loads a part of a node's children (query.a11y with a children range); rejects if the engine refused it or the session ended. */
  readonly load: (node: number, children: ChildRange) => Promise<A11yTree>;
  /** What the engine sent breaks the protocol: the app stops using the engine (spec §14.1 item 5). */
  readonly onViolation: () => void;
}

/** The first entry of `children` whose index is `index` or more (binary search). */
function firstFrom(children: readonly Mirrored[], index: number): number {
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((children[middle] as Mirrored).index < index) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The gaps of a mirrored node: the ranges between the children it holds, and after the last. */
function gapsOfMirrored(node: Mirrored): Gap[] {
  const gaps: Gap[] = [];
  let next = 0;
  for (const child of node.children) {
    if (child.index > next) gaps.push({ node: node.id, start: next, count: child.index - next });
    next = child.index + 1;
  }
  if (next < node.count) gaps.push({ node: node.id, start: next, count: node.count - next });
  return gaps;
}

export class AccessibilityMirror {
  readonly #container: HTMLElement;
  readonly #bridge: InputBridge;
  readonly #options: MirrorOptions;
  readonly #nodes = new Map<number, Mirrored>();
  /** The nodes that lack parts of their children, in the order the mirror learned of them. */
  readonly #partial = new Set<Mirrored>();
  #editable: A11yNode | undefined;
  /** The node the bridge's element stands for. */
  #editableId: number | undefined;
  /** Counts the trees the mirror has held: a part that arrives for an older one is dropped. */
  #generation = 0;
  #loading = false;
  #broken = false;

  constructor(container: HTMLElement, bridge: InputBridge, options: MirrorOptions) {
    this.#container = container;
    this.#bridge = bridge;
    this.#options = options;
    container.setAttribute("translate", "no");
  }

  /** The editable node, if the tree has one: the input bridge needs its character boxes. */
  get editable(): A11yNode | undefined {
    return this.#editable;
  }

  /** How many nodes the mirror holds. */
  get size(): number {
    return this.#nodes.size;
  }

  /** Builds the mirror from the reply to query.a11y for the whole document, and starts loading the parts it lacks. */
  setTree(tree: A11yTree): void {
    if (this.#broken) return;
    if (checkTree(tree.root, 1) === null) {
      this.#violation();
      return;
    }
    this.#forgetAll();
    const root = this.#build(tree.root, 1, null, 0);
    this.#container.replaceChildren(root.element);
    this.#keepBridge();
    this.#bridge.element.inert = false;
    if (!this.#setCaret(tree.caret)) return;
    this.#loadNext();
  }

  /** Applies a11y.update: each change replaces the node with the same identifier, children included. */
  update(update: A11yUpdate): void {
    if (this.#broken) return;
    for (const change of update.changes) {
      const node = change.node as unknown;
      const id = (node as { id?: unknown }).id;
      const old = typeof id === "number" ? this.#nodes.get(id) : undefined;
      // A node the mirror does not hold, such as one in a part not loaded yet, has nothing to replace; its tree is still checked.
      const checked = checkTree(node, old?.level ?? 1);
      if (checked === null) {
        this.#violation();
        return;
      }
      if (old === undefined) continue;
      // The new subtree may reuse the identifiers of the one it replaces, but none from elsewhere: that would make a node appear twice.
      const leaving = new Set(this.#subtree(old).map((leaver) => leaver.id));
      if (checked.ids.some((reused) => this.#nodes.has(reused) && !leaving.has(reused))) {
        this.#violation();
        return;
      }
      this.#forget(old);
      const replacement = this.#build(change.node, old.level, old.parent, old.index);
      if (old.parent === null) {
        // The document node itself.
        this.#container.replaceChildren(replacement.element);
      } else {
        const siblings = old.parent.children;
        siblings[firstFrom(siblings, old.index)] = replacement;
        if (replacement.element !== old.element) old.element.replaceWith(replacement.element);
      }
    }
    this.#keepBridge();
    if (!this.#setCaret(update.caret)) return;
    this.#loadNext();
  }

  /** Clears the mirror, for a new session: no document is open, so the bridge's element holds no text of one and takes no focus. */
  clear(): void {
    this.#forgetAll();
    this.#broken = false;
    this.#container.replaceChildren(this.#bridge.element);
    this.#bridge.sync({ name: "", text: "", caret: null });
    this.#bridge.element.inert = true;
  }

  #violation(): void {
    this.#broken = true;
    this.#options.onViolation();
  }

  /** A document without editable text still needs a place for keyboard focus. */
  #keepBridge(): void {
    if (!this.#container.contains(this.#bridge.element)) this.#container.append(this.#bridge.element);
  }

  /** Writes the editable node's text and caret into the bridge. A caret beyond the editable text breaks the protocol. */
  #setCaret(caret: A11yCaret | null): boolean {
    const node = this.#editable;
    if (node === undefined) return true;
    const text = node.text ?? "";
    const offset = caret !== null && caret.node === node.id ? caret.offset : null;
    if (offset !== null && offset > text.length) {
      this.#violation();
      return false;
    }
    this.#bridge.sync({ name: node.name ?? "", text, caret: offset });
    return true;
  }

  #forgetAll(): void {
    this.#generation += 1;
    this.#loading = false;
    this.#nodes.clear();
    this.#partial.clear();
    this.#editable = undefined;
    this.#editableId = undefined;
  }

  /** A node and every node below it, without recursion. */
  #subtree(node: Mirrored): Mirrored[] {
    const nodes: Mirrored[] = [];
    const pending = [node];
    while (pending.length > 0) {
      const next = pending.pop() as Mirrored;
      nodes.push(next);
      pending.push(...next.children);
    }
    return nodes;
  }

  /** Forgets a subtree that is about to be replaced, in time proportional to it. */
  #forget(node: Mirrored): void {
    for (const leaver of this.#subtree(node)) {
      if (this.#nodes.get(leaver.id) === leaver) this.#nodes.delete(leaver.id);
      this.#partial.delete(leaver);
      if (leaver.id === this.#editableId) {
        // The replacement says again whether there is editable text, and where.
        this.#editable = undefined;
        this.#editableId = undefined;
      }
    }
  }

  /**
   * Builds the mirrored node of a checked node on `level`, with its children's elements. The bridge's element stands for the editable node,
   * unless it already stands for another node of the mirror (only a part could bring a second one): then that node gets an element of its
   * own, so that the bridge's element, which may have focus, is never moved.
   */
  #build(node: A11yNode, level: number, parent: Mirrored | null, index: number): Mirrored {
    const bridged =
      node.editable === true &&
      (this.#editableId === undefined || this.#editableId === node.id || !this.#nodes.has(this.#editableId));
    const run = childRun(node as unknown as Record<string, unknown>) as ChildRun;
    const mirrored: Mirrored = {
      id: node.id,
      element: bridged ? this.#bridge.element : this.#elementFor(node),
      level,
      parent,
      index,
      children: [],
      // The editable text's children are not shown: the bridge's element shows its text.
      count: bridged ? 0 : run.count,
      refused: false,
    };
    const element = mirrored.element;
    element.dataset["nodeId"] = String(node.id);
    this.#nodes.set(node.id, mirrored);
    if (bridged) {
      this.#editable = node;
      this.#editableId = node.id;
      return mirrored;
    }
    if (node.name !== undefined && node.name !== null && node.role === "document") {
      element.setAttribute("aria-label", node.name);
    }
    if (node.text !== undefined && node.text !== null) element.append(node.text);
    const children = node.children ?? [];
    for (const [offset, child] of children.entries()) {
      const built = this.#build(child, level + 1, mirrored, run.start + offset);
      mirrored.children.push(built);
      element.append(built.element);
    }
    if (gapsOf(node.id, run).length > 0) this.#partial.add(mirrored);
    return mirrored;
  }

  /** Loads the next part that a node lacks, one at a time, unless the mirror holds as many nodes as it may. */
  #loadNext(): void {
    if (this.#loading || this.#broken || this.#nodes.size >= MAX_MIRROR_NODES) return;
    for (const node of this.#partial) {
      if (node.refused) continue;
      const [gap] = gapsOfMirrored(node);
      if (gap === undefined) {
        this.#partial.delete(node);
        continue;
      }
      this.#loading = true;
      const generation = this.#generation;
      this.#options.load(node.id, { start: gap.start, count: gap.count }).then(
        (tree) => {
          if (generation !== this.#generation) return;
          this.#loading = false;
          this.#addPart(node, gap, tree);
          this.#loadNext();
        },
        () => {
          if (generation !== this.#generation) return;
          this.#loading = false;
          node.refused = true;
          this.#loadNext();
        },
      );
      return;
    }
  }

  /** Adds a part that query.a11y loaded for `node`'s `gap`, checking it against the request and the mirror first. */
  #addPart(node: Mirrored, gap: Gap, tree: A11yTree): void {
    // The node was replaced or forgotten while the part was on its way: the part belongs to its old version.
    if (this.#broken || this.#nodes.get(node.id) !== node) return;
    const checked = checkTree(tree.root, node.level);
    const run = checked === null ? null : childRun(tree.root as unknown as Record<string, unknown>);
    const fits =
      checked !== null &&
      run !== null &&
      tree.root.id === node.id &&
      run.count === node.count &&
      run.held > 0 &&
      run.start === gap.start &&
      run.held <= gap.count &&
      checked.ids.every((id, position) => position === 0 || !this.#nodes.has(id));
    if (!fits || run === null) {
      this.#violation();
      return;
    }
    const children = tree.root.children ?? [];
    const at = firstFrom(node.children, run.start);
    const before = node.children[at]?.element ?? null;
    const fragment = document.createDocumentFragment();
    const built: Mirrored[] = [];
    for (const [offset, child] of children.entries()) {
      const mirrored = this.#build(child, node.level + 1, node, run.start + offset);
      built.push(mirrored);
      fragment.append(mirrored.element);
    }
    node.element.insertBefore(fragment, before);
    node.children.splice(at, 0, ...built);
    if (gapsOfMirrored(node).length === 0) this.#partial.delete(node);
  }

  #elementFor(node: A11yNode): HTMLElement {
    switch (node.role) {
      case "document": {
        const element = document.createElement("div");
        element.setAttribute("role", "document");
        return element;
      }
      case "heading": {
        const level = node.level ?? 1;
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
