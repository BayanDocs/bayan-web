import { describe, expect, it } from "vitest";
import { checkTree } from "../../src/a11y/tree.ts";

// The checks of accessibility trees (src/a11y/tree.ts, engine protocol §6.6, §14.7 item 1). The conformance vectors of a11y-limits.json
// run against them in conformance.test.ts; these tests cover the fields of nodes and what the vectors leave out.

const node = (id: number, fields: Record<string, unknown> = {}) => ({ id, role: "paragraph", ...fields });

describe("accessibility trees", () => {
  it("accept the nodes of §6.6, and list their identifiers in reading order", () => {
    const tree = {
      ...node(1, { role: "document", name: "Doc", lang: "en" }),
      children: [
        node(2, { role: "heading", level: 2, text: "Title" }),
        node(3, {
          text: "ab",
          editable: true,
          bounds: { page: 0, rect: { x: 0, y: 0, width: 10, height: 10 } },
          chars: [
            { start: 0, end: 1, rect: { x: 0, y: 0, width: 5, height: 10 } },
            { start: 1, end: 2, rect: { x: 5, y: 0, width: 5, height: 10 } },
          ],
          children: [node(4, { text: null, name: null, level: null })],
        }),
      ],
    };
    expect(checkTree(tree, 1)).toEqual({ ids: [1, 2, 3, 4], height: 3, gaps: [] });
  });

  it("refuse fields of the wrong type or beyond their range", () => {
    const refused: Record<string, unknown>[] = [
      { id: 0 },
      { id: 2 ** 53 },
      { id: "2" },
      { role: 7 },
      { level: 0 },
      { level: 10 },
      { text: 5 },
      { editable: "yes" },
      { bounds: { page: -1, rect: { x: 0, y: 0, width: 1, height: 1 } } },
      { children: {} },
      { child_count: -1 },
      { children_start: 1.5 },
      // A character box beyond the node's text, an empty one, and one without text.
      { text: "a", chars: [{ start: 0, end: 2, rect: { x: 0, y: 0, width: 1, height: 1 } }] },
      { text: "a", chars: [{ start: 0, end: 0, rect: { x: 0, y: 0, width: 1, height: 1 } }] },
      { chars: [{ start: 0, end: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }] },
    ];
    for (const fields of refused) {
      expect(
        checkTree({ ...node(1, { role: "document" }), children: [node(2, fields)] }, 1),
        JSON.stringify(fields),
      ).toBe(null);
    }
    expect(checkTree("not a node", 1)).toBeNull();
    expect(checkTree([node(1)], 1)).toBeNull();
    // A hole in a sparse array reads as undefined, which is neither a node nor a character box.
    const sparse = (...entries: unknown[]): unknown[] => {
      const array = [...entries];
      array.length = entries.length + 1;
      return array;
    };
    expect(checkTree({ ...node(1, { role: "document" }), children: sparse(node(2)) }, 1)).toBeNull();
    const box = { start: 0, end: 1, rect: { x: 0, y: 0, width: 1, height: 1 } };
    expect(
      checkTree({ ...node(1, { role: "document" }), children: [node(2, { text: "a", chars: [box] })] }, 1),
    ).not.toBeNull();
    expect(
      checkTree({ ...node(1, { role: "document" }), children: [node(2, { text: "a", chars: sparse(box) })] }, 1),
    ).toBeNull();
  });

  it("refuse an identifier that appears twice, which would put one node in two places", () => {
    expect(checkTree({ ...node(1), children: [node(2), node(2)] }, 1)).toBeNull();
    expect(checkTree({ ...node(1), children: [node(1)] }, 1)).toBeNull();
  });

  it("refuse a root level outside the tree's 64 levels", () => {
    expect(checkTree(node(1), 0)).toBeNull();
    expect(checkTree(node(1), 65)).toBeNull();
    expect(checkTree(node(1), 64)).not.toBeNull();
  });

  it("list the gaps of a node that holds a run of its children, and of one inside it", () => {
    const tree = {
      ...node(1),
      child_count: 10,
      children_start: 4,
      children: [node(2, { child_count: 3 }), node(3)],
    };
    expect(checkTree(tree, 1)?.gaps).toEqual([
      { node: 1, start: 0, count: 4 },
      { node: 1, start: 6, count: 4 },
      { node: 2, start: 0, count: 3 },
    ]);
    // A node that holds all of its children, with or without the two fields, lacks nothing.
    expect(checkTree({ ...node(1), child_count: 2, children: [node(2), node(3)] }, 1)?.gaps).toEqual([]);
  });
});
