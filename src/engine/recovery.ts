// How often the shell may start a new session after an unrecoverable engine error (engine protocol §12.1, the recovery policy both shells
// follow): at most three times in any ten minutes. A panic is a bug that is usually tied to one message or one document, so one restart
// normally recovers and three let the user try twice more; an engine that keeps failing within minutes fails for a reason that restarting
// does not remove, and restarting it without end would keep the processor busy while the user can do nothing. Restarts older than ten
// minutes no longer count, so occasional failures in a long working session never use up the allowance.

/** The most restarts within `restartWindowMs`. */
export const maxRestarts = 3;

/** The span, in milliseconds, over which restarts are counted. */
export const restartWindowMs = 10 * 60 * 1000;

export class RestartAllowance {
  readonly #now: () => number;
  /** When the restarts of the current window happened, oldest first. */
  #restarts: number[] = [];

  /** `now` is a monotonic clock in milliseconds, so that changing the system time changes nothing. */
  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  /**
   * Asks for one more restart. Returns its number within the window (1 to maxRestarts), to tell the user which restart this is, or null
   * when the allowance is used up and the shell must stop instead.
   */
  take(): number | null {
    const now = this.#now();
    this.#restarts = this.#restarts.filter((time) => now - time < restartWindowMs);
    if (this.#restarts.length >= maxRestarts) return null;
    this.#restarts.push(now);
    return this.#restarts.length;
  }
}
