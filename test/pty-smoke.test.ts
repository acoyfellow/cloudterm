import { describe, expect, test } from "bun:test";

import {
  pollForExpectation,
  type Expectation,
  type Snapshot,
} from "./pty-smoke.js";

function snapshot(screen: string): Snapshot {
  return {
    label: "test",
    screen,
    cursor: { row: 0, col: 0 },
    altScreen: false,
    scrollbackLen: 0,
    rows: 1,
    cols: 80,
  };
}

describe("pollForExpectation", () => {
  test("resolves when a later grid read matches", async () => {
    let reads = 0;
    const expectation: Expectation = { rows: { 0: "ready" } };

    const result = await pollForExpectation(
      () => snapshot(++reads === 3 ? "ready" : "loading"),
      expectation,
      { timeoutMs: 100, intervalMs: 0 },
    );

    expect(result).toEqual({ matched: true });
    expect(reads).toBe(3);
  });

  test("returns the last differences after timing out", async () => {
    const expectation: Expectation = { rowPrefixes: { 0: "ready" } };

    const result = await pollForExpectation(
      () => snapshot("loading"),
      expectation,
      { timeoutMs: 0, intervalMs: 0 },
    );

    expect(result.matched).toBe(false);
    expect(result.failure?.differences).toEqual([
      'row 0: expected prefix "ready", actual "loading"',
    ]);
  });
});
