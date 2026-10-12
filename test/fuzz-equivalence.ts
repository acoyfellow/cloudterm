import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHeadless } from '../src/headless.js';

type Terminal = ReturnType<typeof createHeadless>;

const referenceRef = process.env.FUZZ_REF ?? 'v0.0.11';
const trials = Number(process.env.FUZZ_TRIALS ?? 3000);
const seeds = (process.env.FUZZ_SEEDS ?? '1,7,21,41,61').split(',').map(Number);

const pieces = [
  'a', 'bc', 'x'.repeat(130), '\r\n', '\n', '\r', '\b', '\t', '界', '😀', 'e\u0301', 'wide界界界',
  '\x1b[31m', '\x1b[0m', '\x1b[m', '\x1b[1;4m', '\x1b[1m', '\x1b[22m', '\x1b[3m', '\x1b[4m', '\x1b[7m', '\x1b[27m',
  '\x1b[39m', '\x1b[44m', '\x1b[49m', '\x1b[95m', '\x1b[103m', '\x1b[38;5;200m', '\x1b[38;2;1;2;3m', '\x1b[1;31;44m', '\x1b[0;7m',
  '\x1b]8;;https://a.b\x07', '\x1b]8;;\x07',
  '\x1b[H', '\x1b[5;10H', '\x1b[2J', '\x1b[K', '\x1b[3@', '\x1b[2P', '\x1b[4X', '\x1b[?7l', '\x1b[?7h',
  '\x1b[2;8r', '\x1b[r', '\x1bM', '\x1b[3L', '\x1b[2M', '\x1b[?1049h', '\x1b[?1049l', '\x1b7', '\x1b8', '\x1b[10C', '\x1b[3D',
];

function referenceSource(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloudterm-fuzz-'));
  const files = execFileSync('git', ['ls-tree', '--name-only', referenceRef, 'src/'], { encoding: 'utf8' }).split('\n').filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  for (const file of files) writeFileSync(join(dir, file.slice('src/'.length)), execFileSync('git', ['show', `${referenceRef}:${file}`]));
  return dir;
}

function snapshot(terminal: Terminal): string {
  return JSON.stringify({ grid: terminal.grid.serialize(), row: terminal.grid.cursorRow, col: terminal.grid.cursorCol, attr: terminal.getAttr() });
}

function random(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const dir = referenceSource();
try {
  const reference = (await import(join(dir, 'headless.ts'))) as { createHeadless: typeof createHeadless };
  let failures = 0;
  for (const seed of seeds) {
    const next = random(seed);
    for (let trial = 0; trial < trials; trial++) {
      const cols = 5 + Math.floor(next() * 30);
      const rows = 3 + Math.floor(next() * 10);
      let input = '';
      for (let piece = 0; piece < 40; piece++) input += pieces[Math.floor(next() * pieces.length)];
      const current = createHeadless(cols, rows, { maxScrollback: 50 });
      const expected = reference.createHeadless(cols, rows, { maxScrollback: 50 });
      current.feedString(input);
      expected.feedString(input);
      if (snapshot(current) !== snapshot(expected)) {
        failures += 1;
        if (failures <= 3) console.log('mismatch', { seed, cols, rows, input: JSON.stringify(input) });
      }
    }
  }
  console.log(`fuzz-equivalence vs ${referenceRef}: ${seeds.length * trials} inputs, ${failures} mismatches`);
  if (failures > 0) process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
