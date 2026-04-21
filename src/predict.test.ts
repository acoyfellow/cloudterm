import { describe, test, expect } from 'bun:test';
import { PredictionBuffer, type Prediction } from './predict.js';

// Small helpers to keep the test bodies short. `at` is controlled explicitly
// so pruning semantics can be asserted without needing real time.
function print(row: number, col: number, ch: string, at = 0): Prediction {
  return { kind: 'print', row, col, ch, at };
}
function cursor(row: number, col: number, at = 0): Prediction {
  return { kind: 'cursor', row, col, at };
}

function toArray(b: PredictionBuffer): Prediction[] {
  return Array.from(b.iter());
}

describe('PredictionBuffer — basic', () => {
  test('new buffer is empty', () => {
    const b = new PredictionBuffer();
    expect(b.size).toBe(0);
    expect(toArray(b)).toEqual([]);
  });

  test('push adds to size', () => {
    const b = new PredictionBuffer();
    b.push(print(0, 0, 'a'));
    b.push(cursor(0, 1));
    expect(b.size).toBe(2);
  });

  test('iter returns items in insertion order', () => {
    const b = new PredictionBuffer();
    const a = print(0, 0, 'a');
    const c1 = cursor(0, 1);
    const c2 = print(0, 1, 'b');
    b.push(a);
    b.push(c1);
    b.push(c2);
    expect(toArray(b)).toEqual([a, c1, c2]);
  });

  test('clear empties the buffer', () => {
    const b = new PredictionBuffer();
    b.push(print(0, 0, 'a'));
    b.push(print(0, 1, 'b'));
    b.clear();
    expect(b.size).toBe(0);
  });
});

describe('PredictionBuffer — onGridPrint', () => {
  test('matching oldest print prediction drops just that prediction', () => {
    const b = new PredictionBuffer();
    b.push(print(0, 5, 'a'));
    b.push(cursor(0, 6));
    b.push(print(0, 6, 'b'));
    b.onGridPrint(0, 5, 'a');
    expect(b.size).toBe(2);
    const rest = toArray(b);
    expect(rest[0]!.kind).toBe('cursor');
    expect((rest[1] as Extract<Prediction, { kind: 'print' }>).ch).toBe('b');
  });

  test('same (row, col) but different ch drops ALL predictions', () => {
    const b = new PredictionBuffer();
    b.push(print(0, 5, 'a'));
    b.push(print(0, 6, 'b'));
    b.push(cursor(0, 7));
    b.onGridPrint(0, 5, 'x');
    expect(b.size).toBe(0);
  });

  test('unexpected position drops ALL predictions', () => {
    const b = new PredictionBuffer();
    b.push(print(0, 5, 'a'));
    b.push(print(0, 6, 'b'));
    b.onGridPrint(2, 0, 'z');
    expect(b.size).toBe(0);
  });

  test('no-op when no print predictions remain', () => {
    const b = new PredictionBuffer();
    b.push(cursor(0, 1));
    b.onGridPrint(0, 0, 'a');
    expect(b.size).toBe(1);
  });

  test('consumes only the first matching print; subsequent prints still pending', () => {
    // Two typed chars in flight. Server echoes first. Second should still
    // be an active overlay prediction after reconciliation.
    const b = new PredictionBuffer();
    b.push(print(0, 5, 'a'));
    b.push(cursor(0, 6));
    b.push(print(0, 6, 'b'));
    b.push(cursor(0, 7));
    b.onGridPrint(0, 5, 'a');
    expect(b.size).toBe(3);
    // Next print arriving at (0,6) 'b' consumes the second print.
    b.onGridPrint(0, 6, 'b');
    expect(b.size).toBe(2);
  });
});

describe('PredictionBuffer — onGridCursor', () => {
  test('matching oldest cursor prediction drops just that prediction', () => {
    const b = new PredictionBuffer();
    b.push(cursor(0, 6));
    b.push(print(0, 6, 'b'));
    b.push(cursor(0, 7));
    b.onGridCursor(0, 6);
    expect(b.size).toBe(2);
  });

  test('mismatched cursor position drops ALL predictions', () => {
    const b = new PredictionBuffer();
    b.push(cursor(0, 6));
    b.push(print(0, 6, 'b'));
    b.push(cursor(0, 7));
    b.onGridCursor(3, 0);
    expect(b.size).toBe(0);
  });

  test('no-op when no cursor predictions remain', () => {
    const b = new PredictionBuffer();
    b.push(print(0, 0, 'a'));
    b.onGridCursor(0, 1);
    expect(b.size).toBe(1);
  });
});

describe('PredictionBuffer — prune', () => {
  test('removes items older than ttlMs', () => {
    const b = new PredictionBuffer({ ttlMs: 500 });
    b.push(print(0, 0, 'a', 0));
    b.push(print(0, 1, 'b', 100));
    b.push(print(0, 2, 'c', 600));
    // now = 800. Items at 0 and 100 are past 500ms; item at 600 is fresh.
    b.prune(800);
    expect(b.size).toBe(1);
    const rest = toArray(b);
    expect((rest[0] as Extract<Prediction, { kind: 'print' }>).ch).toBe('c');
  });

  test('keeps everything when nothing is stale', () => {
    const b = new PredictionBuffer({ ttlMs: 500 });
    b.push(print(0, 0, 'a', 100));
    b.push(print(0, 1, 'b', 200));
    b.prune(300);
    expect(b.size).toBe(2);
  });

  test('staleness drops everything before the stale item too', () => {
    // Spec: "if a prediction is older than ttlMs and hasn't been confirmed,
    // drop it and everything before it (we gave up on the earlier history
    // too)." The list is in insertion order so earlier = smaller index.
    const b = new PredictionBuffer({ ttlMs: 500 });
    b.push(print(0, 0, 'a', 0));
    b.push(print(0, 1, 'b', 50));
    b.push(print(0, 2, 'c', 400));
    b.push(print(0, 3, 'd', 800));
    // now = 520: 'a' (age 520) is past ttl. Drop 'a' and anything before
    // it (none). Everything else is fresh.
    b.prune(520);
    expect(b.size).toBe(3);
    // now = 600: 'b' (age 550) is now past ttl. Drop 'b' plus everything
    // before it in the current list (none). 'c' (age 200) and 'd' (age
    // -200, pushed "in the future") remain.
    b.prune(600);
    expect(b.size).toBe(2);
  });

  test('empty buffer is a no-op', () => {
    const b = new PredictionBuffer();
    b.prune(1_000_000);
    expect(b.size).toBe(0);
  });
});

describe('PredictionBuffer — defaults', () => {
  test('default ttl is 500ms', () => {
    // Easiest way to verify: push an item at t=0, prune at t=500 (still
    // within ttl on the boundary), then t=501 (past).
    const b = new PredictionBuffer();
    b.push(print(0, 0, 'a', 0));
    b.prune(500);
    expect(b.size).toBe(1);
    b.prune(501);
    expect(b.size).toBe(0);
  });
});
