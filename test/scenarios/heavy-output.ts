// Dense repeated output, run twice, then follow with interactive typing.
// Exists to cover the shape of sessions like `mcp list` that produce many
// similar lines without fancy escapes. The failure mode we want to detect:
// a stale-scrollback scenario where the second run's prompt or subsequent
// speculation lands at the wrong row, which is what a glance at a screenshot
// made us mistakenly diagnose as a speculation bug. If this scenario stays
// green across refactors, we can distinguish "speculation broken" from
// "that screenshot was just stale scrollback".
//
// Three phases:
//   1. Run the loop once, snapshot.
//   2. Run the same loop again, snapshot. New prompt must be on the row
//      immediately after the second run's last output line.
//   3. Type `ls` (no enter), snapshot. Exercises speculation drawing on
//      top of a screen that is mostly scrollback-pushed content.

import type { Scenario } from '../pty-smoke.js';

const PROMPT = '>>> ';

// Dense repeated lines that resemble a real `mcp list` row: index, URL, an
// ISO timestamp, and a trailing tag. 10 lines keeps it well under 24 rows so
// the full output of one run is visible on screen alongside the new prompt.
const LOOP =
  `for i in 1 2 3 4 5 6 7 8 9 10; do ` +
  `echo "line $i: https://example.com/path $i 2026-04-21T10:00:00Z (info)"; ` +
  `done`;

// Sentinel we grep for to know output has landed. "line 10:" is the last
// line the loop prints, so seeing it means the run is fully flushed.
const LAST_LINE = /line 10: https:\/\/example\.com\/path 10/;

export const scenario: Scenario = {
  name: 'heavy-output',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  timeoutMs: 15_000,
  script: [
    { type: 'input', bytes: `export PS1='${PROMPT}' PS2='... '; clear\r` },
    { type: 'waitFor', regex: new RegExp(PROMPT), label: 'initial-prompt' },
    { type: 'snapshot', label: 'before-first-run' },

    // Run 1.
    { type: 'input', bytes: `${LOOP}\r` },
    { type: 'waitFor', regex: LAST_LINE, label: 'first-run-last-line' },
    // Wait for the shell to repaint a fresh prompt after the loop finishes.
    // This is the assertion that matters most for the screenshot case: the
    // prompt has to come back, not be swallowed. dumpScreen() rstrips every
    // row, so the prompt's trailing space is gone by the time we scan; match
    // ">>>" at end-of-line with optional whitespace slop.
    { type: 'waitFor', regex: /^>>>\s*$/m, label: 'prompt-after-run-1' },
    { type: 'snapshot', label: 'after-first-run' },

    // Run 2 (same command). Recreates the "many similar lines above the
    // current prompt" look that triggered today's misdiagnosis.
    { type: 'input', bytes: `${LOOP}\r` },
    { type: 'waitFor', regex: LAST_LINE, label: 'second-run-last-line' },
    { type: 'waitFor', regex: /^>>>\s*$/m, label: 'prompt-after-run-2' },
    { type: 'snapshot', label: 'after-second-run' },

    // Now exercise speculation-on-top-of-dense-scrollback. Type characters
    // without pressing Enter; the grid should show them on the live prompt
    // line. If this renders anywhere else, the cursor/prompt tracking we
    // thought was broken actually is.
    { type: 'input', bytes: 'ls' },
    { type: 'wait', ms: 150 },
    { type: 'snapshot', label: 'typed-ls-no-enter' },

    // Clean up: backspace the typed chars so the shell does not try to run
    // `ls` on exit, then exit.
    { type: 'input', bytes: '\x7f\x7f' },
    { type: 'wait', ms: 100 },
    { type: 'snapshot', label: 'after-backspace' },

    { type: 'input', bytes: 'exit\r' },
  ],
};
