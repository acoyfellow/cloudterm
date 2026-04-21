// Headless paint benchmark. No DOM.
//
// Measures parser + grid cost for a flood of colored output.
// 10,000 SGR-wrapped tokens simulates sustained shell output (e.g. long ls,
// build log with ANSI colors). Since there's no renderer.paint() here, this
// number is purely the cost of feeding bytes into AnsiParser and mutating
// the Grid. The DOM paint win is validated in the browser.
//
// Run: bun run bench

import { createHeadless } from '../src/headless.js';

function run(): void {
  const h = createHeadless(120, 40, { maxScrollback: 10_000 });
  const token = '\x1b[32mfoo\x1b[0m ';
  const N = 10_000;

  // Pre-build the input as one big string so we isolate parser+grid cost.
  const input = token.repeat(N);

  const t0 = performance.now();
  h.feedString(input);
  // Simulated "paint" boundary: read dirtyLines (forces renderer-facing
  // path), then clear. If the new API is available, exercise it; otherwise
  // just read grid.dirty.
  const anyGrid = h.grid as unknown as {
    consumeDirty?: () => { dirtyAll: boolean; dirtyLines: Set<number> };
  };
  if (typeof anyGrid.consumeDirty === 'function') {
    const d = anyGrid.consumeDirty();
    // Touch the result so DCE can't drop it.
    if (d.dirtyLines.size < 0) throw new Error('impossible');
  } else {
    h.grid.dirty = false;
  }
  const t1 = performance.now();

  const ms = t1 - t0;
  const bytes = input.length;
  const perTok = (ms / N) * 1000;
  console.log(
    `bench-paint: ${N} tokens, ${bytes} bytes -> ${ms.toFixed(2)}ms (${perTok.toFixed(2)}us/token)`,
  );
}

run();
