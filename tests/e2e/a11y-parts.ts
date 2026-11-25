import type { Page } from "@playwright/test";

// A document node with more children than one message holds (engine protocol §14.7 item 1), for the tests of the accessibility mirror
// (a11y.spec.ts) and of axe's rules in that state (axe.spec.ts). The mock document is small, so the test stands in for the engine where its
// trees are concerned: before the app starts, it wraps Worker.prototype.postMessage and listens to the engine's worker ahead of the app.
// The real engine's reply to the app's query.a11y for the whole document reaches the app with `extra` paragraphs added after the mock
// document's own children, of which it holds only the first `perMessage`, with child_count and children_start, as the engine does when the
// children do not fit into one message; and the app's query.a11y with a children range for the document node is answered by the test,
// with at most `perMessage` of the requested children each, never reaching the engine. Everything else is the real engine's.
//
// The answers wait until the test calls releaseParts(), so that it can first put keyboard focus in the document. With `withoutStart`, an
// answer leaves out the child its range starts with, which breaks the protocol (§14.7 item 1).

export interface PartsOptions {
  readonly extra: number;
  readonly perMessage: number;
  readonly withoutStart?: boolean;
}

/** The identifier of the added paragraph i, far from the mock document's own. */
export const partId = (index: number) => 9_000_000 + index;

export async function standInForParts(page: Page, options: PartsOptions): Promise<void> {
  await page.addInitScript(({ extra, perMessage, withoutStart }) => {
    interface Node {
      id: number;
      role: string;
      name?: string;
      text?: string;
      children?: Node[];
      child_count?: number;
      children_start?: number;
    }
    const scope = globalThis as unknown as Record<string, unknown>;
    let engineWorker: Worker | undefined;
    let wholeDocument: number | undefined;
    /** The document node's children, the mock document's and the added ones, once the engine's tree has arrived. */
    let all: Node[] = [];
    let root: Node | undefined;
    let docId = 0;
    let released = false;
    const waiting: (() => void)[] = [];
    const queries: { start: number; count: number }[] = [];
    const deliver = (data: unknown) =>
      setTimeout(() =>
        engineWorker?.dispatchEvent(new MessageEvent("message", { data: { __standIn: true, ...(data as object) } })),
      );
    const answer = (id: number, start: number, count: number) => {
      const from = withoutStart ? start + 1 : start;
      const children = all.slice(from, Math.min(start + count, from + perMessage));
      const part = { ...(root as Node), child_count: all.length, children_start: from, children };
      deliver({ v: 1, re: id, ok: true, payload: { doc_id: docId, root: part, caret: null } });
    };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const envelope = message as {
        worker?: unknown;
        id?: number;
        type?: unknown;
        payload?: { node?: number; children?: { start: number; count: number } };
      } | null;
      if (envelope?.worker === "init") {
        engineWorker = this;
        this.addEventListener("message", (event: MessageEvent<unknown>) => {
          const data = event.data as {
            __standIn?: boolean;
            re?: number;
            ok?: boolean;
            payload?: { doc_id: number; root: Node };
          };
          if (data?.__standIn === true || data?.re === undefined || data.re !== wholeDocument || data.ok !== true)
            return;
          // The engine's tree of the whole document: the app gets it with the added paragraphs, only the first part of them held.
          event.stopImmediatePropagation();
          const payload = data.payload as { doc_id: number; root: Node };
          docId = payload.doc_id;
          const own = payload.root.children ?? [];
          const added = Array.from(
            { length: extra },
            (_, index): Node => ({
              id: 9_000_000 + index,
              role: "paragraph",
              text: `Added paragraph ${index}`,
            }),
          );
          all = [...own, ...added];
          const { children: _, ...fields } = payload.root;
          root = fields;
          const held = own.length + perMessage;
          deliver({
            ...data,
            payload: {
              ...payload,
              root: { ...root, child_count: all.length, children_start: 0, children: all.slice(0, held) },
            },
          });
        });
      } else if (envelope?.type === "query.a11y" && envelope.payload?.node === undefined) {
        wholeDocument = envelope.id;
      } else if (
        envelope?.type === "query.a11y" &&
        envelope.payload?.children !== undefined &&
        envelope.id !== undefined
      ) {
        // A part of the document node's children: the test answers, when released.
        const { start, count } = envelope.payload.children;
        const id = envelope.id;
        queries.push({ start, count });
        if (released) answer(id, start, count);
        else waiting.push(() => answer(id, start, count));
        return;
      }
      return Reflect.apply(post, this, [message, transfer]);
    } as typeof Worker.prototype.postMessage;
    scope["__partQueries"] = queries;
    scope["__releaseParts"] = () => {
      released = true;
      for (const send of waiting.splice(0)) send();
    };
  }, options);
}

/** Lets the part answers go, which wait until then. */
export async function releaseParts(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { __releaseParts: () => void }).__releaseParts());
}

/** The children ranges the app asked for, in order. */
export async function partQueries(page: Page): Promise<{ start: number; count: number }[]> {
  return page.evaluate(() =>
    (globalThis as unknown as { __partQueries: { start: number; count: number }[] }).__partQueries.slice(),
  );
}
