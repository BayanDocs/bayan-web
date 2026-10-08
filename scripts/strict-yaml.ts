// A strict reader for the YAML files pnpm reads (work package X-003), shared by the checks of pnpm-lock.yaml and pnpm-workspace.yaml.
//
// YAML can write the same data in many layouts, and pnpm reads them all, so a check that understood only the usual layout could be handed
// a file that pnpm reads differently: a key in double quotes with an escape such as "regis\x74ry", a value in `{…}` style, a key indented
// by four spaces, `version : link:…`. This reader therefore accepts only the layout pnpm itself writes: two spaces per level, plain or
// single-quoted text, `{…}` and `[…]` on one line without nesting, `- item` lists, printable ASCII. Anything else (anchors, aliases, tags,
// double quotes, multi-line text, explicit keys, duplicate keys, other indentation, tabs, a comment after a value) is refused as
// unreadable instead of being guessed at. Lines that hold only a comment are refused too, unless the caller allows them: pnpm-lock.yaml
// has none, while pnpm-workspace.yaml explains its settings with them. A comment line is the same to every YAML reader, because the
// layout accepted here has no multi-line text in which a `#` could mean anything else.

export interface Text {
  kind: "text";
  value: string;
  quoted: boolean;
  line: number;
}
export interface Mapping {
  kind: "mapping";
  entries: Map<string, Node>;
  /** The keys written in single quotes. */
  quotedKeys: Set<string>;
  line: number;
}
export interface List {
  kind: "list";
  items: Node[];
  line: number;
}
export type Node = Text | Mapping | List;

/** A line the reader does not accept. */
export class Unreadable extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

export interface NumberedLine {
  number: number;
  text: string;
}

export interface ReadOptions {
  /** Whether a line that holds only a comment (`# …`, at any indentation) is skipped instead of refused. */
  commentLines: boolean;
}

/** A plain (unquoted) key as pnpm writes it: `.`, a field name, a package name, or a package key such as `name@1.2.3(peer@4.5.6)`. */
const plainKey = /^(?:\.|[A-Za-z0-9_][A-Za-z0-9._~()@/+-]*)$/;

/** Plain text that YAML reads as something other than text (null, a boolean, a number or a date); pnpm quotes such keys. */
const yamlNonText = [
  /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE)$/,
  /^[-+]?(?:0|[1-9][0-9_]*)$/,
  /^[-+]?0(?:b[01_]+|o?[0-7_]+|x[0-9a-fA-F_]+)$/,
  /^[-+]?(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9_]+)(?:[eE][-+]?[0-9]+)?$/,
  /^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/,
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}/,
];

/** Characters that may not start plain text, because YAML gives them a meaning there. */
const indicators = new Set([..."-?:,[]{}#&*!|>'\"%@`"]);

/** Splits a file into numbered lines. */
export function numberedLines(text: string): NumberedLine[] {
  return text.split(/\r?\n/).map((line, index) => ({ number: index + 1, text: line }));
}

function quotedText(text: string, start: number, line: number): { value: string; end: number } {
  let value = "";
  let index = start + 1;
  for (;;) {
    const quote = text.indexOf("'", index);
    if (quote < 0) throw new Unreadable(line, "text in single quotes does not end on its line");
    value += text.slice(index, quote);
    if (text[quote + 1] !== "'") return { value, end: quote + 1 };
    value += "'";
    index = quote + 2;
  }
}

function checkPlainKey(key: string, line: number): void {
  if (!plainKey.test(key) || yamlNonText.some((pattern) => pattern.test(key))) {
    throw new Unreadable(line, `${JSON.stringify(key)} is not a key as pnpm writes one`);
  }
}

function checkPlainText(text: string, line: number, inFlow: boolean): void {
  if (
    text === "" ||
    indicators.has(text[0] ?? "") ||
    text.includes(": ") ||
    text.includes(" #") ||
    text.endsWith(":") ||
    text.endsWith(" ") ||
    /[{}[\]]/.test(text) ||
    (inFlow && text.includes(","))
  ) {
    throw new Unreadable(line, `${JSON.stringify(text)} is not plain text as pnpm writes it`);
  }
}

/** One `{key: value, …}` or `[value, …]` on one line, without nesting. */
function flowCollection(text: string, line: number): Mapping | List {
  const mapping = text[0] === "{";
  const close = mapping ? "}" : "]";
  const entries = new Map<string, Node>();
  const quotedKeys = new Set<string>();
  const items: Node[] = [];
  const done = (end: number): Mapping | List => {
    if (end !== text.length) throw new Unreadable(line, `unexpected text after ${close}`);
    return mapping ? { kind: "mapping", entries, quotedKeys, line } : { kind: "list", items, line };
  };
  let index = 1;
  if (text[index] === close) return done(index + 1);
  const scalar = (): Text => {
    if (text[index] === "'") {
      const quoted = quotedText(text, index, line);
      index = quoted.end;
      return { kind: "text", value: quoted.value, quoted: true, line };
    }
    let end = index;
    while (end < text.length && text[end] !== "," && text[end] !== close) end += 1;
    const plain = text.slice(index, end);
    checkPlainText(plain, line, true);
    index = end;
    return { kind: "text", value: plain, quoted: false, line };
  };
  for (;;) {
    if (mapping) {
      let key: string;
      if (text[index] === "'") {
        const quoted = quotedText(text, index, line);
        key = quoted.value;
        index = quoted.end;
        quotedKeys.add(key);
      } else {
        const colon = text.indexOf(":", index);
        if (colon < 0) throw new Unreadable(line, "a {…} entry has no key");
        key = text.slice(index, colon);
        checkPlainKey(key, line);
        index = colon;
      }
      if (text.slice(index, index + 2) !== ": ") throw new Unreadable(line, "a {…} key is not followed by ': '");
      index += 2;
      if (entries.has(key)) throw new Unreadable(line, `${JSON.stringify(key)} appears twice`);
      entries.set(key, scalar());
    } else {
      items.push(scalar());
    }
    if (text[index] === close) return done(index + 1);
    if (text.slice(index, index + 2) !== ", ") throw new Unreadable(line, `expected ', ' or ${close}`);
    index += 2;
  }
}

/** The value after `key: ` or `- `. */
function value(text: string, line: number): Node {
  if (text[0] === "{" || text[0] === "[") return flowCollection(text, line);
  if (text[0] === "'") {
    const quoted = quotedText(text, 0, line);
    if (quoted.end !== text.length) throw new Unreadable(line, "unexpected text after the closing quote");
    return { kind: "text", value: quoted.value, quoted: true, line };
  }
  checkPlainText(text, line, false);
  return { kind: "text", value: text, quoted: false, line };
}

/** Reads one YAML document, given as numbered lines; throws Unreadable at the first line it does not accept. */
export function readDocument(lines: readonly NumberedLine[], options: ReadOptions): Mapping {
  const root: Mapping = { kind: "mapping", entries: new Map(), quotedKeys: new Set(), line: lines[0]?.number ?? 1 };
  // A block whose children are written `indent` spaces in; `node` stays undefined until its first child shows whether it is a mapping or a list.
  interface Block {
    indent: number;
    node: Mapping | List | undefined;
    owner?: { mapping: Mapping; key: string; line: number };
  }
  const blocks: Block[] = [{ indent: 0, node: root }];
  const close = (block: Block) => {
    if (block.node === undefined && block.owner) {
      throw new Unreadable(block.owner.line, `${JSON.stringify(block.owner.key)} has no value`);
    }
  };
  for (const { number, text } of lines) {
    if (text === "") continue;
    if (/[^\x20-\x7e]/.test(text))
      throw new Unreadable(number, "the line has a tab or a character outside printable ASCII");
    if (text.endsWith(" ")) throw new Unreadable(number, "the line ends with a space");
    const content = text.trimStart();
    if (content.startsWith("#")) {
      if (options.commentLines) continue;
      throw new Unreadable(number, "comments are not part of this file's format");
    }
    const indent = text.length - content.length;
    let block = blocks[blocks.length - 1];
    while (block !== undefined && indent < block.indent) {
      close(block);
      blocks.pop();
      block = blocks[blocks.length - 1];
    }
    if (block === undefined || indent !== block.indent) {
      throw new Unreadable(number, "the indentation is not two spaces deeper than the line it belongs to");
    }
    const listItem = content.startsWith("- ");
    if (block.node === undefined && block.owner) {
      block.node = listItem
        ? { kind: "list", items: [], line: number }
        : { kind: "mapping", entries: new Map(), quotedKeys: new Set(), line: number };
      block.owner.mapping.entries.set(block.owner.key, block.node);
    }
    const node = block.node;
    if (node === undefined) throw new Unreadable(number, "unexpected line");
    if (node.kind === "list") {
      if (!listItem) throw new Unreadable(number, "a mapping entry where the list continues");
      node.items.push(value(content.slice(2), number));
      continue;
    }
    if (listItem) throw new Unreadable(number, "a list item where a mapping entry belongs");
    let key: string;
    let index: number;
    if (content[0] === "'") {
      const quoted = quotedText(content, 0, number);
      key = quoted.value;
      index = quoted.end;
      node.quotedKeys.add(key);
    } else {
      index = content.indexOf(":");
      if (index < 0) throw new Unreadable(number, "the line is not `key: value`");
      key = content.slice(0, index);
      checkPlainKey(key, number);
    }
    if (content[index] !== ":") throw new Unreadable(number, "the key is not followed by ':'");
    if (node.entries.has(key)) throw new Unreadable(number, `${JSON.stringify(key)} appears twice`);
    if (index + 1 === content.length) {
      blocks.push({ indent: indent + 2, node: undefined, owner: { mapping: node, key, line: number } });
      continue;
    }
    if (content[index + 1] !== " " || content[index + 2] === " ") {
      throw new Unreadable(number, "the key is not followed by ': ' and a value");
    }
    node.entries.set(key, value(content.slice(index + 2), number));
  }
  for (const block of blocks.reverse()) close(block);
  return root;
}

/** Describes a node for a message: its text, or what kind of node it is. */
export function describe(node: Node | undefined): string {
  if (node === undefined) return "nothing";
  if (node.kind === "text") return JSON.stringify(node.value);
  return node.kind === "mapping" ? "a mapping" : "a list";
}
