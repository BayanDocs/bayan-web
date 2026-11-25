// What the shell accepts from the engine (engine protocol §14.1 item 5): every message from the worker must be a plain object whose
// envelope, and for each message type this shell knows, whose payload have the fields, types and ranges that the protocol gives, before
// any of it is used. A message that fails is a protocol violation, which ends the shell's use of the engine (src/engine/client.ts says
// how). Unknown message types and unknown fields are not violations (§9): they are left alone. The accessibility trees inside query.a11y
// and a11y.update, whose depth counts from where they sit in the document, are checked where that is known (src/a11y/tree.ts).
//
// Pure functions without browser APIs, so that the unit tests can check them exactly (tests/unit/engine-checks.test.ts).

import {
  type ErrorInfo,
  MAX_COORDINATE,
  MAX_ENGINE_VERSION_LENGTH,
  MAX_ID,
  MAX_INDEX,
  MAX_PAGES,
  MAX_TILE_SIDE,
  type Rect,
  type RequestType,
} from "./protocol.ts";

/** An object as structured clone delivers one that the worker host built from JSON: no class, no array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** An integer from `min` to `max`. */
export function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** A request identifier, document identifier, node identifier, sequence number or render revision: an integer from 1 to 2⁵³ − 1 (§4). */
export function isId(value: unknown): value is number {
  return isInteger(value, 1, MAX_ID);
}

const isIndex = (value: unknown): value is number => isInteger(value, 0, MAX_INDEX);
const isCoordinate = (value: unknown): value is number => isInteger(value, -MAX_COORDINATE, MAX_COORDINATE);
const isSize = (value: unknown): value is number => isInteger(value, 0, MAX_COORDINATE);
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isAbsent = (value: unknown): boolean => value === undefined || value === null;

/**
 * Whether every entry of an array passes `check`, counting by index, so that a hole in a sparse array reads as undefined, which no check
 * accepts (Array.prototype.every would skip it).
 */
export function everyEntry(array: readonly unknown[], check: (entry: unknown, index: number) => boolean): boolean {
  for (let index = 0; index < array.length; index += 1) if (!check(array[index], index)) return false;
  return true;
}

const isArrayOf = (value: unknown, item: (entry: unknown) => boolean): value is unknown[] =>
  Array.isArray(value) && everyEntry(value, (entry) => item(entry));

/** A rectangle in BLU (§7): integer edges and a size that is not negative, within ±2⁴⁰. */
export function isRect(value: unknown): value is Rect {
  return (
    isPlainObject(value) &&
    isCoordinate(value["x"]) &&
    isCoordinate(value["y"]) &&
    isSize(value["width"]) &&
    isSize(value["height"])
  );
}

/** A rectangle on a page. */
export function isPageRect(value: unknown): boolean {
  return isPlainObject(value) && isIndex(value["page"]) && isRect(value["rect"]);
}

/** The engine's version as `welcome` and the worker host's `ready` carry it: 1 to 64 printable ASCII characters (§14.1 item 6). */
export function isEngineVersion(value: unknown): value is string {
  return (
    isString(value) && value.length > 0 && value.length <= MAX_ENGINE_VERSION_LENGTH && /^[\x20-\x7e]+$/.test(value)
  );
}

/** The error of a failed reply (§4, §12): a code and a message identifier, and arguments that the shell never shows. */
export function isErrorInfo(value: unknown): value is ErrorInfo {
  return (
    isPlainObject(value) && isString(value["code"]) && isString(value["message_id"]) && isPlainObject(value["args"])
  );
}

/** The accessibility caret (§6.6): a node and an offset into its text, or null. */
export function isA11yCaret(value: unknown): boolean {
  return value === null || (isPlainObject(value) && isId(value["node"]) && isIndex(value["offset"]));
}

/** A key named by `key` or by `code`, exactly one of them (§14.3). */
function namesOneKey(entry: Record<string, unknown>): boolean {
  const key = entry["key"];
  const code = entry["code"];
  return (isString(key) && key !== "" && isAbsent(code)) || (isString(code) && code !== "" && isAbsent(key));
}

/** A binding of a command (§14.3): a key with all four modifiers, and its label. */
function isKeyBinding(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    namesOneKey(value) &&
    ["ctrl", "shift", "alt", "meta"].every((modifier) => isBoolean(value[modifier])) &&
    isString(value["label"])
  );
}

/** A reserved key (§14.3): a key with only the modifiers that matter; the others are absent or null. */
function isReservedKey(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    namesOneKey(value) &&
    ["ctrl", "shift", "alt", "meta"].every((modifier) => isAbsent(value[modifier]) || isBoolean(value[modifier]))
  );
}

function isUiCommand(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isString(value["id"]) &&
    isString(value["label"]) &&
    isArrayOf(value["bindings"], isKeyBinding) &&
    (isAbsent(value["shell_action"]) || isString(value["shell_action"]))
  );
}

function isUiKeys(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isArrayOf(value["document"], (entry) => isPlainObject(entry) && isString(entry["key"]) && entry["key"] !== "") &&
    isArrayOf(value["reserved"], isReservedKey)
  );
}

function isWarning(value: unknown): boolean {
  return isPlainObject(value) && isString(value["message_id"]) && isPlainObject(value["args"]);
}

/** Whether a successful reply's payload has the shape of the reply to `type`. `isBitmap` tells an ImageBitmap (a browser type). */
export function checkReply(
  type: RequestType,
  payload: Record<string, unknown>,
  isBitmap: (value: unknown) => boolean,
): boolean {
  switch (type) {
    case "hello":
      return (
        isIndex(payload["protocol_version"]) &&
        isEngineVersion(payload["engine_version"]) &&
        isIndex(payload["layout_epoch"]) &&
        isArrayOf(payload["features"], isString)
      );
    case "ui.manifest":
      return (
        isIndex(payload["manifest_version"]) &&
        isString(payload["locale"]) &&
        isArrayOf(payload["commands"], isUiCommand) &&
        isUiKeys(payload["keys"]) &&
        isPlainObject(payload["ribbon"])
      );
    case "doc.open": {
      const fonts = payload["fonts"];
      return (
        isId(payload["doc_id"]) &&
        isId(payload["revision"]) &&
        isIndex(payload["page_count_estimate"]) &&
        isArrayOf(payload["warnings"], isWarning) &&
        isPlainObject(fonts) &&
        isArrayOf(fonts["missing"], isString) &&
        isBoolean(fonts["machine_dependent"])
      );
    }
    case "render.tile":
      return (
        isBitmap(payload["bitmap"]) &&
        isInteger(payload["width"], 1, MAX_TILE_SIDE) &&
        isInteger(payload["height"], 1, MAX_TILE_SIDE) &&
        isString(payload["hash"]) &&
        isId(payload["revision"])
      );
    case "query.a11y":
      // The tree itself is checked where its level in the document is known (src/a11y/tree.ts).
      return isId(payload["doc_id"]) && isPlainObject(payload["root"]) && isA11yCaret(payload["caret"]);
    case "diag.record.stop":
      return (
        payload["blob"] instanceof ArrayBuffer &&
        isInteger(payload["entries"], 0, MAX_ID) &&
        isBoolean(payload["truncated"])
      );
    case "diag.replay":
      return (
        isInteger(payload["entries"], 0, MAX_ID) &&
        isBoolean(payload["identical"]) &&
        (payload["first_difference"] === null || isInteger(payload["first_difference"], 0, MAX_ID)) &&
        Array.isArray(payload["tiles"])
      );
    case "doc.close":
    case "view.set":
    case "input.pointer":
    case "input.key":
    case "input.text":
    case "input.composition":
    case "diag.record.start":
    case "diag.panic":
      // Empty replies: whatever fields a later version adds are left alone.
      return true;
  }
}

function isPageInfo(value: unknown, index: number): boolean {
  return (
    isPlainObject(value) &&
    value["index"] === index &&
    isInteger(value["width"], 1, MAX_COORDINATE) &&
    isInteger(value["height"], 1, MAX_COORDINATE) &&
    isIndex(value["section"]) &&
    isCoordinate(value["x"]) &&
    isCoordinate(value["y"])
  );
}

function isCaret(value: unknown): boolean {
  return (
    value === null ||
    (isPlainObject(value) && isIndex(value["page"]) && isRect(value["rect"]) && isBoolean(value["visible"]))
  );
}

function isSelectionRects(value: unknown): boolean {
  return isPlainObject(value) && isIndex(value["page"]) && isArrayOf(value["rects"], isRect);
}

function isA11yChange(value: unknown): boolean {
  // "replace" is the only kind of change in v1; another value is not an addition that v1 allows (§9).
  return isPlainObject(value) && value["kind"] === "replace" && isPlainObject(value["node"]);
}

/**
 * Whether an event's payload has the shape of its type. An event type this shell does not know passes: it is ignored (§9). The `restart`
 * of engine.error is read by the session tracker (src/engine/session.ts).
 */
export function checkEvent(type: string, payload: Record<string, unknown>): boolean {
  switch (type) {
    case "view.layout.progress":
      return (
        isId(payload["doc_id"]) &&
        isIndex(payload["pages_laid_out"]) &&
        isIndex(payload["page_count_estimate"]) &&
        isBoolean(payload["complete"])
      );
    case "view.pages": {
      const pages = payload["pages"];
      return (
        isId(payload["doc_id"]) && Array.isArray(pages) && pages.length <= MAX_PAGES && everyEntry(pages, isPageInfo)
      );
    }
    case "render.invalidate":
      return isId(payload["doc_id"]) && isId(payload["revision"]) && isArrayOf(payload["regions"], isPageRect);
    case "overlay.update":
      return (
        isId(payload["doc_id"]) &&
        isId(payload["revision"]) &&
        isCaret(payload["caret"]) &&
        isArrayOf(payload["selection"], isSelectionRects) &&
        Array.isArray(payload["remote"]) &&
        Array.isArray(payload["highlights"])
      );
    case "a11y.update":
      return isId(payload["doc_id"]) && isArrayOf(payload["changes"], isA11yChange) && isA11yCaret(payload["caret"]);
    case "engine.error":
      return (
        isString(payload["code"]) &&
        isString(payload["message_id"]) &&
        isBoolean(payload["recoverable"]) &&
        isPlainObject(payload["args"])
      );
    default:
      return true;
  }
}

/** A message from the worker, sorted by its envelope (§3.2, §4); `violation` when the envelope breaks the protocol. */
export type Incoming =
  | { readonly kind: "ready"; readonly engineVersion: string }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "control" }
  | {
      readonly kind: "reply";
      readonly v: unknown;
      readonly re: number;
      readonly ok: true;
      readonly payload: Record<string, unknown>;
    }
  | { readonly kind: "reply"; readonly v: unknown; readonly re: number; readonly ok: false; readonly error: ErrorInfo }
  | {
      readonly kind: "event";
      readonly v: unknown;
      readonly type: string;
      readonly seq: number;
      readonly payload: Record<string, unknown>;
    }
  | { readonly kind: "violation" };

/**
 * Sorts a message from the worker by its envelope, checking each envelope field's type: the worker host's control messages (a `worker`
 * field and no `v`, which are not protocol messages), replies (`re`) and events (`type` and `seq`). The version `v` is the caller's to
 * check, because the reply to `hello` is exempt (§14.1 item 1). A payload may be left out where it would be empty (§4).
 */
export function readEnvelope(data: unknown): Incoming {
  if (!isPlainObject(data)) return { kind: "violation" };
  if ("worker" in data && !("v" in data)) {
    if (data["worker"] === "ready") {
      // The engine's version, at most 64 ASCII characters (§14.1 item 6); the status line shows it.
      return isEngineVersion(data["engine_version"])
        ? { kind: "ready", engineVersion: data["engine_version"] }
        : { kind: "violation" };
    }
    if (data["worker"] === "failed") {
      return { kind: "failed", reason: isString(data["reason"]) ? data["reason"] : "failed" };
    }
    return { kind: "control" };
  }
  const v = data["v"];
  const payload = data["payload"] === undefined ? {} : data["payload"];
  if (!isInteger(v, 0, MAX_INDEX) || !isPlainObject(payload)) return { kind: "violation" };
  if ("re" in data) {
    const re = data["re"];
    if (!isId(re) || (data["type"] !== undefined && !isString(data["type"]))) return { kind: "violation" };
    if (data["ok"] === true) return { kind: "reply", v, re, ok: true, payload };
    if (data["ok"] === false && isErrorInfo(data["error"]))
      return { kind: "reply", v, re, ok: false, error: data["error"] };
    return { kind: "violation" };
  }
  const type = data["type"];
  const seq = data["seq"];
  if (!isString(type) || !isId(seq)) return { kind: "violation" };
  return { kind: "event", v, type, seq, payload };
}
