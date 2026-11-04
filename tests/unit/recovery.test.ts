import { describe, expect, it } from "vitest";
import { maxRestarts, RestartAllowance, restartWindowMs } from "../../src/engine/recovery.ts";

// The restart limit of the recovery policy (engine protocol §12.1). The end-to-end test (tests/e2e/recovery.spec.ts) checks it with the real
// engine; this checks the window, which would take ten minutes there.

function allowance() {
  let now = 1_000;
  const restarts = new RestartAllowance(() => now);
  return { restarts, advance: (ms: number) => (now += ms) };
}

describe("RestartAllowance", () => {
  it("allows three restarts in ten minutes and refuses the fourth", () => {
    const { restarts, advance } = allowance();
    expect(maxRestarts).toBe(3);
    expect(restartWindowMs).toBe(600_000);
    expect(restarts.take()).toBe(1);
    advance(1);
    expect(restarts.take()).toBe(2);
    advance(1);
    expect(restarts.take()).toBe(3);
    advance(restartWindowMs - 3);
    expect(restarts.take()).toBeNull();
    // A refusal is not a restart: it does not hold the allowance back once the window has moved on.
    expect(restarts.take()).toBeNull();
  });

  it("forgets each restart ten minutes after it", () => {
    const { restarts, advance } = allowance();
    expect(restarts.take()).toBe(1);
    advance(60_000);
    expect(restarts.take()).toBe(2);
    advance(60_000);
    expect(restarts.take()).toBe(3);
    // Ten minutes after the first restart, only the other two count.
    advance(restartWindowMs - 120_000);
    expect(restarts.take()).toBe(3);
    expect(restarts.take()).toBeNull();
    // Long after all of them, the allowance is whole again.
    advance(restartWindowMs);
    expect(restarts.take()).toBe(1);
  });

  it("restarts every time when failures are further apart than the window", () => {
    const { restarts, advance } = allowance();
    for (let failure = 0; failure < 10; failure += 1) {
      expect(restarts.take()).toBe(1);
      advance(restartWindowMs);
    }
  });
});
