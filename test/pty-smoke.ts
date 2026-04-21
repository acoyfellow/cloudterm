// Real-shell smoke harness. Spawns a shell in a PTY, pipes its output through
// cloudterm's parser + grid via src/headless.ts, and captures diagnostic
// snapshots of grid state. No DOM. No assertions — the report is a human
// artifact.
//
// Keep everything in one file: the Scenario/Step shape, runScenario(), and
// the helpers for dumping grid state. Scenarios live in ./scenarios/*.ts.

import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import * as pty from 'node-pty';
import { createHeadless, type Headless } from '../src/headless.js';
import type { Cell } from '../src/grid.js';

// Bun's tarball extractor drops the execute bit on the node-pty spawn-helper
// binary. Without +x, every pty.spawn() errors with "posix_spawnp failed".
// Detect and repair once per process so `bun add node-pty` users don't have
// to know this. No-op if the file already looks executable.
(() => {
  try {
    const req = createRequire(import.meta.url);
    const ptyPath = req.resolve('node-pty/package.json');
    const root = dirname(ptyPath);
    const candidates = [
      join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
      join(root, 'prebuilds', 'darwin-x64', 'spawn-helper'),
      join(root, 'build', 'Release', 'spawn-helper'),
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      const mode = statSync(p).mode;
      if ((mode & 0o111) === 0) {
        chmodSync(p, 0o755);
      }
    }
  } catch {
    /* if node-pty isn't installed we'll blow up at spawn time with a clearer error */
  }
})();

export type Step =
  | { type: 'input'; bytes: string | Uint8Array }
  | { type: 'wait'; ms: number }
  | { type: 'waitFor'; regex: RegExp; timeoutMs?: number; label?: string }
  | { type: 'snapshot'; label: string };

export interface Scenario {
  name: string;
  shell: string;
  cols: number;
  rows: number;
  script: Step[];
  /** If set and returns false, scenario is skipped with the given reason. */
  skipIf?: () => { skip: true; reason: string } | { skip: false };
  /** Per-scenario overall timeout. Default 15_000ms. */
  timeoutMs?: number;
}

export interface Snapshot {
  label: string;
  screen: string;
  cursor: { row: number; col: number };
  altScreen: boolean;
  scrollbackLen: number;
  rows: number;
  cols: number;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  skipReason?: string;
  snapshots: Snapshot[];
  steps: { type: string; label?: string; durationMs: number; note?: string }[];
  error?: string;
  durationMs: number;
  bytesReceived: number;
  finalScreen?: string;
  finalCursor?: { row: number; col: number };
  finalAltScreen?: boolean;
}

/** Render grid.screen as one row per line, trailing whitespace trimmed per
 *  row for readability. Trailing blank rows are kept as empty lines so row
 *  indices line up with the cursor report. */
export function dumpScreen(rows: Cell[][]): string {
  const out: string[] = [];
  for (const row of rows) {
    let s = '';
    for (const cell of row) s += cell.ch;
    out.push(s.replace(/\s+$/u, ''));
  }
  return out.join('\n');
}

function takeSnapshot(h: Headless, label: string): Snapshot {
  return {
    label,
    screen: dumpScreen(h.grid.screen),
    cursor: { row: h.grid.cursorRow, col: h.grid.cursorCol },
    altScreen: h.grid.inAltScreen,
    scrollbackLen: h.grid.scrollback.length,
    rows: h.grid.rows,
    cols: h.grid.cols,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const started = Date.now();
  const result: ScenarioResult = {
    name: scenario.name,
    passed: false,
    snapshots: [],
    steps: [],
    durationMs: 0,
    bytesReceived: 0,
  };

  if (scenario.skipIf) {
    const r = scenario.skipIf();
    if (r.skip) {
      result.passed = true;
      result.skipped = true;
      result.skipReason = r.reason;
      result.durationMs = Date.now() - started;
      return result;
    }
  }

  const headless = createHeadless(scenario.cols, scenario.rows);

  let term: pty.IPty | undefined;
  try {
    term = pty.spawn(scenario.shell, [], {
      name: 'xterm-256color',
      cols: scenario.cols,
      rows: scenario.rows,
      cwd: process.cwd(),
      env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
    });
  } catch (err) {
    result.error = `spawn failed: ${(err as Error).message}`;
    result.durationMs = Date.now() - started;
    return result;
  }

  term.onData((data) => {
    // node-pty emits strings by default. writeString is cheaper than
    // re-encoding to bytes.
    result.bytesReceived += data.length;
    headless.parser.writeString(data);
  });

  let exitCode: number | null = null;
  term.onExit((e) => {
    exitCode = e.exitCode;
  });

  const overallDeadline = started + (scenario.timeoutMs ?? 15_000);

  const writeInput = (input: string | Uint8Array) => {
    if (typeof input === 'string') {
      term!.write(input);
    } else {
      term!.write(Buffer.from(input).toString('binary'));
    }
  };

  const waitForRegex = async (rx: RegExp, timeoutMs: number): Promise<boolean> => {
    const deadline = Math.min(Date.now() + timeoutMs, overallDeadline);
    while (Date.now() < deadline) {
      const dump = dumpScreen(headless.grid.screen);
      if (rx.test(dump)) return true;
      await sleep(20);
    }
    return false;
  };

  try {
    // Give the shell a moment to print its initial prompt before the script
    // starts issuing input. Without this, early `input` steps race the
    // shell's own first paint.
    await sleep(150);

    for (const step of scenario.script) {
      if (Date.now() > overallDeadline) {
        throw new Error(`scenario exceeded timeoutMs (${scenario.timeoutMs ?? 15_000})`);
      }
      const stepStarted = Date.now();
      switch (step.type) {
        case 'input':
          writeInput(step.bytes);
          result.steps.push({
            type: 'input',
            durationMs: Date.now() - stepStarted,
            note:
              typeof step.bytes === 'string'
                ? JSON.stringify(step.bytes).slice(0, 80)
                : `<${step.bytes.length} bytes>`,
          });
          break;
        case 'wait':
          await sleep(step.ms);
          result.steps.push({ type: 'wait', durationMs: Date.now() - stepStarted });
          break;
        case 'waitFor': {
          const ok = await waitForRegex(step.regex, step.timeoutMs ?? 3000);
          result.steps.push({
            type: 'waitFor',
            label: step.label,
            durationMs: Date.now() - stepStarted,
            note: `${step.regex.toString()} -> ${ok ? 'match' : 'TIMEOUT'}`,
          });
          if (!ok) {
            throw new Error(
              `waitFor ${step.regex.toString()} timed out after ${step.timeoutMs ?? 3000}ms`,
            );
          }
          break;
        }
        case 'snapshot': {
          // Small drain: wait 50ms for any in-flight output to settle so the
          // snapshot reflects steady state rather than a half-painted frame.
          await sleep(50);
          result.snapshots.push(takeSnapshot(headless, step.label));
          result.steps.push({
            type: 'snapshot',
            label: step.label,
            durationMs: Date.now() - stepStarted,
          });
          break;
        }
      }
    }

    result.passed = true;
  } catch (err) {
    result.error = (err as Error).message;
    // Capture a final snapshot so failures are debuggable.
    result.snapshots.push(takeSnapshot(headless, '__on_error__'));
  } finally {
    // Ensure shell exits even if the scenario didn't send "exit".
    try {
      term.write('\x04'); // EOT; terminates many line editors / shells
    } catch {
      /* already gone */
    }
    // Try graceful exit, then kill.
    const killStarted = Date.now();
    while (exitCode === null && Date.now() - killStarted < 500) {
      await sleep(20);
    }
    if (exitCode === null) {
      try {
        term.kill();
      } catch {
        /* noop */
      }
    }

    const final = takeSnapshot(headless, '__final__');
    result.finalScreen = final.screen;
    result.finalCursor = final.cursor;
    result.finalAltScreen = final.altScreen;
    result.durationMs = Date.now() - started;
  }

  return result;
}
