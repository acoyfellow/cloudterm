import { describe, expect, test } from 'bun:test';
import { createHeadless } from './headless.js';
import { Grid } from './grid.js';
import { defaultAttr } from './parser.js';

function state(grid: Grid): unknown {
  const lines = Array.from({ length: grid.totalLines() }, (_, offset) => {
    return grid.getLine(grid.trimmed + offset).map(({ ch, attr }) => ({ ch, attr }));
  });
  return {
    lines,
    cursor: [grid.cursorRow, grid.cursorCol],
    modes: {
      applicationCursor: grid.applicationCursorMode,
      bracketedPaste: grid.bracketedPasteMode,
      autowrap: grid.autoWrapMode,
      mouseTracking: grid.mouseTracking,
      mouseSgr: grid.mouseSgr,
    },
  };
}

describe('Grid serialize and restore', () => {
  test('round trips cells, attributes, cursor, modes, and scrollback', () => {
    const source = createHeadless(12, 3, { maxScrollback: 10 });
    source.feedString('\x1b[31;1mred\x1b[0m 日本\x1b]8;;https://example.com/docs\x1b\\link\x1b]8;;\x1b\\\r\none\r\ntwo\r\nthree\r\nfour');
    source.feedString('\x1b[?1h\x1b[?2004h\x1b[?7l\x1b[?1002h\x1b[?1006h\x1b[2;5H');
    const expected = state(source.grid);
    const restored = createHeadless(12, 3, { maxScrollback: 10 });
    restored.restore(source.serialize());
    expect(state(restored.grid)).toEqual(expected);
  });

  test('fits snapshots into smaller and larger grids and clamps cursor', () => {
    const source = createHeadless(8, 3);
    source.feedString('abcdefgh\r\nijklmnop\r\nqrstuvwx\x1b[3;8H');
    const snapshot = source.serialize();
    const small = createHeadless(4, 2);
    const large = createHeadless(12, 5);
    expect(() => small.restore(snapshot)).not.toThrow();
    expect(() => large.restore(snapshot)).not.toThrow();
    expect(small.grid.cursorRow).toBeLessThan(small.grid.rows);
    expect(small.grid.cursorCol).toBeLessThan(small.grid.cols);
    expect(large.grid.cursorRow).toBeLessThan(large.grid.rows);
    expect(large.grid.cursorCol).toBeLessThan(large.grid.cols);
    expect(small.grid.getLine(small.grid.trimmed + small.grid.scrollback.length)[0]!.ch).toBe('i');
    expect(large.grid.screen[3]!.map((cell) => cell.ch).join('')).toBe(' '.repeat(12));
  });

  test('serializes the main buffer from alt screen and restores to main', () => {
    const source = createHeadless(10, 2);
    source.feedString('main\x1b[?1049halt');
    const snapshot = source.serialize();
    expect(JSON.parse(snapshot).alt).toBe(true);
    const restored = createHeadless(10, 2);
    restored.restore(snapshot);
    expect(restored.grid.inAltScreen).toBe(false);
    expect(restored.grid.screen[0]![0]!.ch).toBe('m');
  });

  test('rejects malformed snapshots without changing the grid', () => {
    const terminal = createHeadless(8, 2);
    terminal.feedString('unchanged');
    const before = terminal.serialize();
    for (const value of ['not json', JSON.stringify({ ...JSON.parse(before), v: 2 }), JSON.stringify({ ...JSON.parse(before), cursor: 'wrong' })]) {
      expect(() => terminal.restore(value)).toThrow();
      expect(terminal.serialize()).toBe(before);
    }
  });

  test('compresses ten thousand identical colored lines below 300 KB', () => {
    const grid = new Grid(80, 1, 10_000);
    const attr = { ...defaultAttr(), fg: 196 };
    for (let index = 0; index < 10_000; index++) {
      grid.screen[0] = Array.from({ length: 80 }, () => ({ ch: 'x', attr }));
      grid.scrollUp(1);
    }
    expect(new TextEncoder().encode(grid.serialize()).byteLength).toBeLessThan(300 * 1024);
  });
});
