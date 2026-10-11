import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHeadless } from './headless.js';

const DIR = join(import.meta.dir, '..', 'test', 'conformance');
const COLS = 80;
const ROWS = 24;

const screenOf = (bytes: Uint8Array) => {
  const term = createHeadless(COLS, ROWS);
  term.feed(bytes);
  const grid = term.grid;
  const top = grid.trimmed + grid.scrollback.length;
  const lines: string[] = [];
  for (let r = 0; r < ROWS; r++) lines.push(grid.getLine(top + r).map((cell) => cell.ch).join('').trimEnd());
  return { lines, cursor: [grid.cursorRow, grid.cursorCol] };
};

const truthOf = (text: string) => {
  const marker = /<<cursor (\d+),(\d+)>>\s*$/.exec(text);
  const body = marker ? text.slice(0, marker.index) : text;
  const lines = body.replace(/\n$/, '').split('\n').map((l) => l.trimEnd());
  while (lines.length < ROWS) lines.push('');
  return { lines: lines.slice(0, ROWS), cursor: marker ? [Number(marker[1]), Number(marker[2])] : null };
};

describe('tmux conformance: screen matches tmux capture-pane', () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.bin')).sort()) {
    const name = file.slice(0, -4);
    test(name, () => {
      const got = screenOf(new Uint8Array(readFileSync(join(DIR, file))));
      const want = truthOf(readFileSync(join(DIR, `${name}.txt`), 'utf8'));
      expect(got.lines).toEqual(want.lines);
      if (want.cursor) expect(got.cursor).toEqual(want.cursor);
    });
  }
});
