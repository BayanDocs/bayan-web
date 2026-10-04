// Access to the browser's localStorage that never throws.

/**
 * Returns the browser's localStorage, or undefined when this page may not use it.
 * Merely reading `window.localStorage` throws a SecurityError when the user blocks sites from saving data, so the property read
 * itself must be guarded; methods such as getItem and setItem can also throw and are guarded where they are called (theme.ts).
 */
export function safeLocalStorage(host: { readonly localStorage: Storage } = window): Storage | undefined {
  try {
    return host.localStorage;
  } catch {
    return undefined;
  }
}
