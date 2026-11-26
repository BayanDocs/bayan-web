// The accessibility mirror (ADR-0014 §6, ADR-0020 §4): a DOM copy of the engine's accessibility tree (spec §6.6) that people never see
// but screen readers read, because the pages themselves are pixels on a canvas. Headings, paragraphs, lists and tables become the HTML
// elements with those meanings, built with safe DOM APIs only (no HTML from strings); the editable text becomes the input bridge's
// element, which holds the engine's text and caret, so that a screen reader follows the engine's caret there (the caret-sync prototype).
// a11y.update replaces changed nodes in place; a change that replaces the editable node itself leaves the bridge's element where it is, so
// that it keeps focus.
//
// Protocol v1 (spec §14.7 item 1). The engine keeps every tree within the limits of 64 levels and 200,000 nodes per message, flattening
// what lies deeper into the text of the node at level 64, so the mirror builds every node it receives as an element of its own, after
// checking the tree (tree.ts): a tree beyond the limits, or one that contradicts itself or what the mirror holds, breaks the protocol, and
// the mirror reports it instead of building anything (onViolation), so that the app stops using the engine. Where a node's children do
// not all fit into one message, the node holds a run of them and says how many it has; the mirror shows the node with all its children
// by loading the parts it lacks with query.a11y { node, children: { start, count } }, one part at a time, as soon as it learns of them.
// A part fills a gap next to the children the mirror holds and never replaces one, so loading moves none of the elements the mirror holds.
// The one exception is the bridge's element: an editable node that first arrives in a part, while the mirror holds none, takes it there,
// and with it any focus it had (a follow-up for WEB-005).
//
// A faulty engine cannot keep the mirror loading: each answer must hold the child its range starts with (so every answer adds to the
// node's fixed number of children), no more than the range asked for, the node's unchanged number of children and only identifiers new
// to the mirror; anything else breaks the protocol. A node whose part the engine refuses leaves the queue of nodes to load for good; only
// a replacement, which is a node of its own, joins it again. And the mirror loads no more parts once it holds MAX_MIRROR_NODES nodes. That
// bound applies to loading parts only: a11y.update builds what each change holds, up to the protocol's 200,000 nodes per message, however
// large the mirror is (bounding the mirror across updates is a follow-up for CORE-128 and WEB-102).
//
// Every step takes time in proportion to what it touches: building visits each node once, a replacement forgets only the subtree it
// replaces, and a part joins the end of one of its node's lists (Mirrored), so that finding a node's next gap and placing a part take
// constant time, however its parts arrive. Children are added and walked one at a time and never spread into a call, whose arguments
// browsers limit to about 100,000, while a message may hold 200,000 nodes and a node more once its parts are loaded. No work recurses
// deeper than the tree's 64 levels.
//
// While no document is open the input bridge's element is inert, out of the tab order and the accessibility tree, so that it is never a
// text box with no name and no text. The mirror is also marked translate="no": a browser's page translation would otherwise send the
// document's text to a translation service, which is why the input bridges switch off spell checking too.

import type { A11yCaret, A11yNode, A11yTree, A11yUpdate, ChildRange } from "../engine/protocol.ts";
import type { InputBridge } from "../input/bridge.ts";
import { type ChildRun, checkTree, childRun, type Gap, gapsOf } from "./tree.ts";

/**
 * The most nodes the mirror holds before it stops loading parts: five times what one message may hold. Beyond it a document's remaining
 * parts stay unloaded rather than make the browser build millions of elements (a follow-up decides loading them as the reader moves). It
 * bounds part loading only, not a11y.update, which builds what each change holds (a follow-up bounds the mirror across updates).
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
  /**
   * The children it holds, in three unbroken runs by index: `run`, those its own message held, from index `runStart`; `before`, those that
   * parts added in front of the run, from index 0; and `after`, those that parts added behind it. Parts fill the first gap first, so these
   * are all the children it holds, and a child's place follows from its index without a search.
   */
  readonly run: Mirrored[];
  readonly runStart: number;
  readonly before: Mirrored[];
  readonly after: Mirrored[];
  /** How many children it has; more than it holds while parts are missing. */
  readonly count: number;
}

export interface MirrorOptions {
  /** Loads a part of a node's children (query.a11y with a children range); rejects if the engine refused it or the session ended. */
  readonly load: (node: number, children: ChildRange) => Promise<A11yTree>;
  /** What the engine sent breaks the protocol: the app stops using the engine (spec §14.1 item 5). */
  readonly onViolation: () => void;
}

/** The first range of a mirrored node's children that it lacks, in constant time: in front of its run, or behind it. */
function firstGap(node: Mirrored): Gap | undefined {
  if (node.before.length < node.runStart) {
    return { node: node.id, start: node.before.length, count: node.runStart - node.before.length };
  }
  const next = node.runStart + node.run.length + node.after.length;
  return next < node.count ? { node: node.id, start: next, count: node.count - next } : undefined;
}

/** The list of a node's children that holds the child with index `index`, and its place there; undefined if the node lacks that child. */
function placeOf(node: Mirrored, index: number): { readonly list: Mirrored[]; readonly position: number } | undefined {
  if (index < node.before.length) return { list: node.before, position: index };
  const inRun = index - node.runStart;
  if (inRun >= 0 && inRun < node.run.length) return { list: node.run, position: inRun };
  const inAfter = inRun - node.run.length;
  if (inAfter >= 0 && inAfter < node.after.length) return { list: node.after, position: inAfter };
  return undefined;
}

export class AccessibilityMirror {
  readonly #container: HTMLElement;
  readonly #bridge: InputBridge;
  readonly #options: MirrorOptions;
  readonly #nodes = new Map<number, Mirrored>();
  /**
   * The nodes that lack parts of their children, in the order the mirror learned of them, from `#partialHead` on. Parts load for the node
   * at the head until it holds all its children, the engine refuses one of them, or the node is replaced; then the head moves on and never
   * comes back, so that no node is looked at twice.
   */
  #partial: Mirrored[] = [];
  #partialHead = 0;
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
    const root = this.#build(tree.root, 1, null, 0, () => undefined);
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
      const leaving = new Set<number>();
      for (const leaver of this.#subtree(old)) leaving.add(leaver.id);
      if (checked.ids.some((reused) => this.#nodes.has(reused) && !leaving.has(reused))) {
        this.#violation();
        return;
      }
      this.#forget(old);
      const parent = old.parent;
      const replacement = this.#build(change.node, old.level, parent, old.index, (placed) => {
        const place = parent === null ? undefined : placeOf(parent, old.index);
        if (place !== undefined) place.list[place.position] = placed;
      });
      if (parent === null) {
        // The document node itself.
        this.#container.replaceChildren(replacement.element);
      } else if (replacement.element !== old.element) {
        old.element.replaceWith(replacement.element);
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
    this.#partial = [];
    this.#partialHead = 0;
    this.#editable = undefined;
    this.#editableId = undefined;
  }

  /** A node and every node below it, without recursion, one child at a time. */
  #subtree(node: Mirrored): Mirrored[] {
    const nodes: Mirrored[] = [];
    const pending = [node];
    while (pending.length > 0) {
      const next = pending.pop() as Mirrored;
      nodes.push(next);
      for (const child of next.before) pending.push(child);
      for (const child of next.run) pending.push(child);
      for (const child of next.after) pending.push(child);
    }
    return nodes;
  }

  /** Forgets a subtree that is about to be replaced, in time proportional to it. */
  #forget(node: Mirrored): void {
    // Nodes of the queue that leave are passed over when the head reaches them (#loadNext).
    for (const leaver of this.#subtree(node)) {
      if (this.#nodes.get(leaver.id) === leaver) this.#nodes.delete(leaver.id);
      if (leaver.id === this.#editableId) {
        // The replacement says again whether there is editable text, and where.
        this.#editable = undefined;
        this.#editableId = undefined;
      }
    }
  }

  /**
   * Builds the mirrored node of a checked node on `level`, with its children's elements. `place` puts it among its parent's children as
   * soon as the mirror registers it, before anything below it is built, so that whatever might fail later, every node the mirror holds is
   * also among its parent's children. The bridge's element stands for the editable node, unless it already stands for another node of the
   * mirror (only a part could bring a second one): then that node gets an element of its own, so that the bridge's element, which may have
   * focus, is not moved.
   */
  #build(
    node: A11yNode,
    level: number,
    parent: Mirrored | null,
    index: number,
    place: (mirrored: Mirrored) => void,
  ): Mirrored {
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
      run: [],
      // The editable text's children are not shown: the bridge's element shows its text.
      runStart: bridged ? 0 : run.start,
      before: [],
      after: [],
      count: bridged ? 0 : run.count,
    };
    const element = mirrored.element;
    element.dataset["nodeId"] = String(node.id);
    this.#nodes.set(node.id, mirrored);
    place(mirrored);
    if (bridged) {
      this.#editable = node;
      this.#editableId = node.id;
      return mirrored;
    }
    if (gapsOf(node.id, run).length > 0) this.#partial.push(mirrored);
    if (node.name !== undefined && node.name !== null && node.role === "document") {
      element.setAttribute("aria-label", node.name);
    }
    if (node.text !== undefined && node.text !== null) element.append(node.text);
    const children = node.children ?? [];
    for (const [offset, child] of children.entries()) {
      const built = this.#build(child, level + 1, mirrored, run.start + offset, (placed) => mirrored.run.push(placed));
      element.append(built.element);
    }
    return mirrored;
  }

  /** Loads the next part that a node lacks, one at a time, unless the mirror holds as many nodes as it may. */
  #loadNext(): void {
    if (this.#loading || this.#broken || this.#nodes.size >= MAX_MIRROR_NODES) return;
    while (this.#partialHead < this.#partial.length) {
      const node = this.#partial[this.#partialHead] as Mirrored;
      // A node that was replaced or forgotten, or that now holds all its children, needs nothing more.
      const gap = this.#nodes.get(node.id) === node ? firstGap(node) : undefined;
      if (gap === undefined) {
        this.#passHead();
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
          // Refused: none of the node's parts is asked for again. It is still the head, since nothing else moves the head while a part
          // is on its way.
          if (this.#partial[this.#partialHead] === node) this.#passHead();
          this.#loadNext();
        },
      );
      return;
    }
  }

  /** Moves the queue's head past its node, and lets go of the passed part of the queue once it outweighs the rest. */
  #passHead(): void {
    this.#partialHead += 1;
    if (this.#partialHead >= 1_024 && this.#partialHead * 2 >= this.#partial.length) {
      this.#partial = this.#partial.slice(this.#partialHead);
      this.#partialHead = 0;
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
    // A gap in front of the run fills `before`, one behind it `after`, both at their ends. Each child joins its list as the mirror
    // registers it (#build), so the lists and the mirror's nodes always agree; the elements follow as one fragment.
    const inFront = gap.start < node.runStart;
    const list = inFront ? node.before : node.after;
    const fragment = document.createDocumentFragment();
    const children = tree.root.children ?? [];
    for (const [offset, child] of children.entries()) {
      const built = this.#build(child, node.level + 1, node, gap.start + offset, (placed) => list.push(placed));
      fragment.append(built.element);
    }
    // In front of the run's first element, or after everything the node holds.
    const next = inFront ? (node.run[0] ?? node.after[0]) : undefined;
    node.element.insertBefore(
      fragment,
      next !== undefined && next.element.parentNode === node.element ? next.element : null,
    );
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
