// The checks of an accessibility tree from the engine (engine protocol §6.6, §14.7 item 1), before the mirror (mirror.ts) builds anything
// from it. The engine keeps every tree within the limits: at most 64 levels deep, the document node being level 1, and at most 200,000
// nodes in one reply to query.a11y or one change of an a11y.update; where a node's children do not all fit into one message, it holds an
// unbroken run of them and says how many it has (child_count) and where the run starts (children_start). A tree beyond the limits, or one
// that contradicts itself, breaks the protocol (§14.1 item 5): the shell stops using the engine rather than guess.
//
// The walk keeps its own list of nodes still to visit instead of recursing, so that no tree can exhaust the call stack, and it visits each
// node once. It also lists the parts of children that the tree lacks, in reading order (depth first, each node before its children) and
// for each node from its first child to its last, each as one range of the whole gap: the query.a11y { node, children: { start, count } }
// that loads it. No browser APIs, so that the unit tests can run the conformance vectors of a11y-limits.json (§15) against it.

import { everyEntry, isId, isInteger, isPageRect, isPlainObject, isRect } from "../engine/checks.ts";
import { MAX_INDEX, MAX_TREE_DEPTH, MAX_TREE_NODES } from "../engine/protocol.ts";

/** A range of a node's children that a tree lacks: what query.a11y loads (§14.7 item 1). */
export interface Gap {
  readonly node: number;
  readonly start: number;
  readonly count: number;
}

/** A tree that passed its checks. */
export interface CheckedTree {
  /** The identifier of every node, in reading order. */
  readonly ids: readonly number[];
  /** How many levels the tree spans: 1 for a node without children. */
  readonly height: number;
  /** The ranges of children it lacks, in reading order. */
  readonly gaps: readonly Gap[];
}

/** Which of a node's children a node holds, once it passed its checks: `held` of `count`, from index `start`. */
export interface ChildRun {
  readonly count: number;
  readonly start: number;
  readonly held: number;
}

const isOptional = (value: unknown, check: (value: unknown) => boolean): boolean =>
  value === undefined || value === null || check(value);

/** Whether a node's own fields have the types and ranges of §6.6, which the mirror reads. Its children are checked as nodes of their own. */
function hasNodeFields(node: Record<string, unknown>): boolean {
  const text = node["text"];
  const chars = node["chars"];
  return (
    isId(node["id"]) &&
    typeof node["role"] === "string" &&
    isOptional(node["level"], (level) => isInteger(level, 1, 9)) &&
    isOptional(node["name"], (name) => typeof name === "string") &&
    isOptional(text, (value) => typeof value === "string") &&
    (node["editable"] === undefined || typeof node["editable"] === "boolean") &&
    isOptional(node["bounds"], isPageRect) &&
    isOptional(
      chars,
      (boxes) =>
        Array.isArray(boxes) &&
        everyEntry(
          boxes,
          (box) =>
            isPlainObject(box) &&
            isInteger(box["start"], 0, MAX_INDEX) &&
            isInteger(box["end"], (box["start"] as number) + 1, typeof text === "string" ? text.length : 0) &&
            isRect(box["rect"]),
        ),
    ) &&
    isOptional(node["children"], Array.isArray) &&
    isOptional(node["child_count"], (count) => isInteger(count, 0, MAX_INDEX)) &&
    isOptional(node["children_start"], (start) => isInteger(start, 0, MAX_INDEX))
  );
}

/**
 * Which children a checked node holds (§14.7 item 1): all of them, or, with child_count, an unbroken run from children_start (0 when
 * absent) that lies within child_count. Null if it holds more than it says it has. A node whose run covers all of its children holds them
 * all, with or without the two fields.
 */
export function childRun(node: Record<string, unknown>): ChildRun | null {
  const children = Array.isArray(node["children"]) ? node["children"].length : 0;
  const count = node["child_count"];
  if (typeof count !== "number") return { count: children, start: 0, held: children };
  const start = children > 0 && typeof node["children_start"] === "number" ? node["children_start"] : 0;
  return start + children > count ? null : { count, start, held: children };
}

/** The gaps of a node's run: before it, and after it. */
export function gapsOf(id: number, run: ChildRun): Gap[] {
  const gaps: Gap[] = [];
  if (run.held === 0) {
    if (run.count > 0) gaps.push({ node: id, start: 0, count: run.count });
    return gaps;
  }
  if (run.start > 0) gaps.push({ node: id, start: 0, count: run.start });
  const end = run.start + run.held;
  if (end < run.count) gaps.push({ node: id, start: end, count: run.count - end });
  return gaps;
}

/**
 * Checks a tree whose root sits at `rootLevel` of the document's tree (1 for the document node, more for a reply to query.a11y for a node
 * below it): every node's fields, the depth limit counted from the document, the node limit, identifiers that are unique, and runs of
 * children that lie within their counts. Returns null if any check fails: the tree breaks the protocol.
 */
export function checkTree(root: unknown, rootLevel: number): CheckedTree | null {
  if (!isInteger(rootLevel, 1, MAX_TREE_DEPTH)) return null;
  const pending: { readonly value: unknown; readonly level: number }[] = [{ value: root, level: rootLevel }];
  const ids: number[] = [];
  const seen = new Set<number>();
  const gaps: Gap[] = [];
  let height = 0;
  while (pending.length > 0) {
    const { value, level } = pending.pop() as { value: unknown; level: number };
    if (level > MAX_TREE_DEPTH || !isPlainObject(value) || !hasNodeFields(value)) return null;
    const id = value["id"] as number;
    if (seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
    height = Math.max(height, level - rootLevel + 1);
    const children = Array.isArray(value["children"]) ? (value["children"] as unknown[]) : [];
    // The nodes read, those waiting and these children may not exceed the limit: checked before any child is queued.
    if (ids.length + pending.length + children.length > MAX_TREE_NODES) return null;
    const run = childRun(value);
    if (run === null) return null;
    gaps.push(...gapsOf(id, run));
    for (let child = children.length - 1; child >= 0; child -= 1)
      pending.push({ value: children[child], level: level + 1 });
  }
  return { ids, height, gaps };
}
