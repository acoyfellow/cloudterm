import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createHeadless } from './headless.js';
import { createHeadless as createOracle } from '/Users/jcoeyman/cloudflare/cloudterm/.git/loop18/oracle/headless.js';
import { Grid } from './grid.js';
import { Grid as OracleGrid } from '/Users/jcoeyman/cloudflare/cloudterm/.git/loop18/oracle/grid.js';
import { DomRenderer, defaultTheme } from './renderer.js';
import { DomRenderer as OracleRenderer } from '/Users/jcoeyman/cloudflare/cloudterm/.git/loop18/oracle/renderer.js';

const window = new Window();
Object.assign(globalThis, { window, document: window.document });

type Random = () => number;

function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

const PRINTABLE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()-_=+[]{};:,.<>/?';
const WIDE = ['日', '本', '語', '😀', '中', '한'];
const COMBINING = ['e\u0301', 'a\u0308', 'n\u0303'];
const SEQUENCES = [
  '\r\n', '\n', '\r', '\b', '\t', '\x1b[H', '\x1b[2J', '\x1b[J', '\x1b[1J', '\x1b[K', '\x1b[1K', '\x1b[2K',
  '\x1b[3A', '\x1b[2B', '\x1b[5C', '\x1b[4D', '\x1b[2;5H', '\x1b[10;1H', '\x1b[L', '\x1b[2M', '\x1b[3@', '\x1b[2P', '\x1b[4X',
  '\x1b[S', '\x1b[2T', '\x1bM', '\x1bD', '\x1bE', '\x1b7', '\x1b8', '\x1b[s', '\x1b[u', '\x1b[2;4r', '\x1b[r',
  '\x1b[0m', '\x1b[1m', '\x1b[3m', '\x1b[4m', '\x1b[7m', '\x1b[9m', '\x1b[22m', '\x1b[31m', '\x1b[42m', '\x1b[38;5;208m',
  '\x1b[48;5;17m', '\x1b[38;2;10;200;30m', '\x1b[48;2;250;1;99m', '\x1b[39m', '\x1b[49m', '\x1b[?7l', '\x1b[?7h',
  '\x1b[?25l', '\x1b[?25h', '\x1b[?1049h', '\x1b[?1049l', '\x1b[?47h', '\x1b[?47l', '\x1b]8;;https://example.com\x07', '\x1b]8;;\x07',
  '\x1b]0;title\x07', '\x1b[?2004h', '\x1b[?2004l', '\x1b[3J',
];

function chunk(random: Random, combining: boolean): string {
  const kind = random() % 10;
  if (kind < 5) {
    let text = '';
    const length = 1 + (random() % 40);
    for (let i = 0; i < length; i++) text += PRINTABLE[random() % PRINTABLE.length];
    return text;
  }
  if (kind === 5) return WIDE[random() % WIDE.length]!;
  if (kind === 6) return combining ? COMBINING[random() % COMBINING.length]! : WIDE[random() % WIDE.length]!;
  return SEQUENCES[random() % SEQUENCES.length]!;
}

function stream(seed: number, chunks: number, combining = true): string[] {
  const random = seeded(seed);
  const out: string[] = [];
  for (let i = 0; i < chunks; i++) out.push(chunk(random, combining));
  return out;
}

function lineOf(grid: { getLine(index: number): { ch: string; attr: object }[] }, index: number) {
  return grid.getLine(index).map((cell) => [cell.ch, JSON.stringify(cell.attr)]);
}

function state(grid: Grid | OracleGrid) {
  const lines = [];
  for (let i = 0; i < grid.totalLines(); i++) lines.push(lineOf(grid as never, i));
  return {
    cols: grid.cols,
    rows: grid.rows,
    total: grid.totalLines(),
    cursor: [grid.cursorRow, grid.cursorCol, grid.cursorVisible],
    lines,
    serialized: grid.serialize(),
  };
}

describe('typed grid keeps main behavior', () => {
  for (const [seed, cols, rows, scrollback] of [
    [1, 20, 6, 50], [2, 80, 24, 1000], [3, 7, 3, 0], [4, 120, 40, 200], [5, 33, 11, 5], [6, 1, 1, 10], [7, 64, 16, 10000], [8, 12, 30, 3],
  ] as const) {
    test(`seed ${seed} at ${cols}x${rows}, scrollback ${scrollback}`, () => {
      const actual = createHeadless(cols, rows, { maxScrollback: scrollback });
      const expected = createOracle(cols, rows, { maxScrollback: scrollback });
      const random = seeded(seed * 7919);
      for (const [index, piece] of stream(seed, 3000).entries()) {
        actual.feedString(piece);
        expected.feedString(piece);
        if (random() % 400 === 0) {
          const nextCols = 1 + (random() % 90);
          const nextRows = 1 + (random() % 30);
          actual.resize(nextCols, nextRows);
          expected.resize(nextCols, nextRows);
        }
        if (index % 500 === 499) expect(state(actual.grid)).toEqual(state(expected.grid));
      }
      expect(state(actual.grid)).toEqual(state(expected.grid));
      expect(actual.search('a')).toEqual(expected.search('a'));
    });
  }

  test('serialize output restores identically in both', () => {
    const source = createOracle(30, 8, { maxScrollback: 100 });
    for (const piece of stream(99, 2000, false)) source.feedString(piece);
    const data = source.serialize();
    const actual = createHeadless(30, 8, { maxScrollback: 100 });
    const expected = createOracle(30, 8, { maxScrollback: 100 });
    actual.restore(data);
    expected.restore(data);
    expect(state(actual.grid)).toEqual(state(expected.grid));
  });

  test('a 100,000 line flood keeps identical scrollback and screen', () => {
    const actual = createHeadless(120, 40, { maxScrollback: 10000 });
    const expected = createOracle(120, 40, { maxScrollback: 10000 });
    let text = '';
    for (let i = 0; i < 100000; i++) text += `line ${i} ${'x'.repeat(i % 80)}\r\n`;
    actual.feedString(text);
    expected.feedString(text);
    expect(state(actual.grid)).toEqual(state(expected.grid));
  });
});

function renderedHtml(seed: number, Make: 'actual' | 'oracle'): string {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const headless = Make === 'actual' ? createHeadless(24, 8, { maxScrollback: 40 }) : createOracle(24, 8, { maxScrollback: 40 });
  const renderer = Make === 'actual'
    ? new DomRenderer(host as never, headless.grid as Grid, defaultTheme)
    : new OracleRenderer(host as never, headless.grid as OracleGrid, defaultTheme);
  renderer.charWidth = 8;
  renderer.lineHeight = 16;
  Object.defineProperty(renderer.viewport, 'clientHeight', { configurable: true, value: 8 * 16 });
  for (const [index, piece] of stream(seed, 1500).entries()) {
    headless.feedString(piece);
    if (index % 97 === 0) renderer.paint();
  }
  renderer.paint();
  const html = host.innerHTML;
  host.remove();
  return html;
}

describe('typed grid renders the same DOM as main', () => {
  for (const seed of [11, 12, 13, 14]) {
    test(`seed ${seed}`, () => {
      expect(renderedHtml(seed, 'actual')).toBe(renderedHtml(seed, 'oracle'));
    });
  }
});
