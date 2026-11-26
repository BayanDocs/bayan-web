// Which engine session a message from the engine belongs to, and what the shell does with it (engine protocol §12.1 step 4, §14.1, §14.2):
// the one rule that the client (src/engine/client.ts) applies to every reply and event whose envelope and payload passed their checks, kept
// apart so that the conformance vectors of restart.json (§15) test exactly it (tests/unit/conformance.test.ts runs them through the client).
//
// - The error panic answers the message that made the engine fail, just before the engine.error that says what follows: ignored.
// - A reply to a request sent before the current session's hello belongs to an earlier session: ignored. Requests are numbered in the order
//   they are sent, so the hello's number divides them.
// - engine.error with recoverable false: the engine discarded its session, and its `restart` says what follows (§14.2): { number, limit },
//   the engine is ready for restart `number` of `limit`, and the shell starts it with hello; null, the engine has stopped and answers
//   nothing more. The shell counts nothing itself. A missing or malformed `restart` breaks the protocol (§14.1 item 5). Both of those, and
//   null, stop the shell's use of the engine.
// - Any other event before the current hello's welcome, or about a document that the current session did not open, belongs to an earlier
//   session: ignored.
// - Everything else belongs to the current session and is handled.

import { isId, isInteger, isPlainObject } from "./checks.ts";
import { MAX_INDEX, type Restart } from "./protocol.ts";

export type Decision =
  | { readonly action: "handle" }
  | { readonly action: "ignore" }
  | { readonly action: "restart"; readonly restart: Restart }
  | { readonly action: "stop"; readonly reason: "restarts_used_up" | "protocol_violation" };

const handle: Decision = { action: "handle" };
const ignore: Decision = { action: "ignore" };

/**
 * The `restart` of an engine.error with recoverable false (§14.2): { number, limit } with number from 1 to limit; null when the allowance
 * is used up; undefined when it is missing or malformed.
 */
export function restartOf(value: unknown): Restart | null | undefined {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  const { number, limit } = value;
  return isInteger(limit, 1, MAX_INDEX) && isInteger(number, 1, limit) ? { number, limit } : undefined;
}

export class SessionTracker {
  /** The current session's hello, and whether its welcome arrived. */
  #hello: number | undefined;
  #welcomed = false;
  /** The current session's doc.open requests that wait for their reply, and the documents that it opened. */
  readonly #opening = new Set<number>();
  readonly #documents = new Set<number>();

  /** The shell sent a message of `type`, with the request identifier `id`, or without one (§4). A hello starts a session. */
  sent(type: string, id: number | undefined): void {
    if (type === "hello" && id !== undefined) {
      this.#hello = id;
      this.#welcomed = false;
      this.#opening.clear();
      this.#documents.clear();
    } else if (type === "doc.open" && id !== undefined) {
      this.#opening.add(id);
    }
  }

  /** What the shell does with the reply to request `re`: `payload` for a success, `code` for the error of a failure. */
  reply(re: number, ok: boolean, payload: Record<string, unknown>, code: string | undefined): Decision {
    if (!ok && code === "panic") {
      this.#opening.delete(re);
      return ignore;
    }
    if (this.#hello === undefined || re < this.#hello) return ignore;
    if (re === this.#hello) this.#welcomed = ok;
    if (this.#opening.delete(re) && ok && isId(payload["doc_id"])) this.#documents.add(payload["doc_id"]);
    return handle;
  }

  /** What the shell does with an event of `type`. */
  event(type: string, payload: Record<string, unknown>): Decision {
    if (type === "engine.error" && payload["recoverable"] === false) {
      const restart = restartOf(payload["restart"]);
      if (restart === undefined) return { action: "stop", reason: "protocol_violation" };
      return restart === null ? { action: "stop", reason: "restarts_used_up" } : { action: "restart", restart };
    }
    if (!this.#welcomed) return ignore;
    const document = payload["doc_id"];
    if (isId(document) && !this.#documents.has(document)) return ignore;
    return handle;
  }
}
