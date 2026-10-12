// The rule of the app's Trusted Types policy (src/security/script-url-policy.ts), kept free of browser APIs so unit tests can check it.

/**
 * Returns `input` if it is exactly one of `allowed`, the same-origin URL paths of the app's own built scripts that may be started as
 * workers; throws a TypeError for anything else: other origins, protocol-relative addresses, blob: and data: URLs, relative paths, query
 * strings, fragments, and paths that merely resolve to an allowed one ("/assets/../assets/…", "%2E", backslashes). The comparison is
 * exact on purpose: the allowed paths are written by the build, so there is nothing to normalize, and every other spelling is refused.
 * The error message never repeats the refused address.
 */
export function allowedScriptUrl(input: unknown, allowed: ReadonlySet<string>): string {
  if (typeof input !== "string" || !allowed.has(input) || !isPlainPath(input)) {
    throw new TypeError("bayan-script-url refused a script address that is not one of the app's own worker scripts.");
  }
  return input;
}

/**
 * Whether a path is an absolute same-origin URL path made only of plain segments: it starts with exactly one "/", has no query or
 * fragment, no backslash, no percent-escape and no "." or ".." segment. Checked on the allowed paths too, so a build that wrote a strange
 * path into the allowlist still cannot make the policy accept it.
 */
export function isPlainPath(path: string): boolean {
  return (
    /^\/[A-Za-z0-9._~/-]*$/.test(path) &&
    !path.startsWith("//") &&
    path.split("/").every((segment, index) => index === 0 || (segment !== "" && segment !== "." && segment !== ".."))
  );
}
