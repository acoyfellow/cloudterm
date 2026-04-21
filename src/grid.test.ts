import { describe, test, expect } from 'bun:test';
import { createHeadless } from './headless.js';
import type { Grid } from './grid.js';

// Drive a real Grid through the real AnsiParser via createHeadless, the
// documented headless entry point. No mocks; all state assertions read
// directly from the Grid.
function makeTerm(cols = 20, rows = 6): { grid: Grid; write: (s: string) => void } {
  const h = createHeadless(cols, rows, { maxScrollback: 1000 });
  return { grid: h.grid, write: (s: string) => h.feedString(s) };
}

// Read the visible text on a row (trailing blanks trimmed).
function rowText(grid: Grid, row: number): string {
  const r = grid.screen[row];
  if (!r) return '';
  return r.map((c) => c.ch).join('').replace(/\s+$/, '');
}

// Read visible text across all screen rows, joined by \n, with trailing
// blank rows stripped. Useful for asserting preserved main content.
function screenText(grid: Grid): string {
  const lines: string[] = [];
  for (let r = 0; r < grid.rows; r++) lines.push(rowText(grid, r));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

const ENTER_1049 = '\x1b[?1049h';
const EXIT_1049 = '\x1b[?1049l';
const ENTER_47 = '\x1b[?47h';
const EXIT_47 = '\x1b[?47l';
const SAVE_1048 = '\x1b[?1048h';
const RESTORE_1048 = '\x1b[?1048l';

describe('Grid alt-screen buffer via CSI ?1049', () => {
  test('main screen content is preserved across enter/write/exit cycle', () => {
    const { grid, write } = makeTerm(20, 6);

    // Dirty the main screen.
    write('alpha\r\nbeta\r\ngamma');
    const mainBefore = screenText(grid);
    expect(mainBefore).toBe('alpha\nbeta\ngamma');
    expect(grid.inAltScreen).toBe(false);

    // Enter alt, write junk, exit.
    write(ENTER_1049);
    expect(grid.inAltScreen).toBe(true);
    // On entry the alt buffer is cleared, so we see blank rows.
    expect(screenText(grid)).toBe('');
    write('this should not leak');
    write(EXIT_1049);
    expect(grid.inAltScreen).toBe(false);

    // Main screen must be exactly as we left it.
    expect(screenText(grid)).toBe(mainBefore);
  });

  test('1049 saves cursor on enter and restores on exit', () => {
    const { grid, write } = makeTerm(40, 10);

    // Park cursor at row 5 col 10 (0-based).
    write('\x1b[6;11H'); // CSI 6;11H = 1-based row 6, col 11
    expect(grid.cursorRow).toBe(5);
    expect(grid.cursorCol).toBe(10);

    // Enter alt, write text that moves cursor.
    write(ENTER_1049);
    write('\x1b[1;1H'); // home
    write('hello world foo bar');
    expect(grid.cursorRow).toBe(0);
    expect(grid.cursorCol).toBe(19);

    // Exit. Cursor must be back at (5, 10) on the main buffer.
    write(EXIT_1049);
    expect(grid.inAltScreen).toBe(false);
    expect(grid.cursorRow).toBe(5);
    expect(grid.cursorCol).toBe(10);
  });

  test('alt-screen scrolling does not grow main scrollback', () => {
    const { grid, write } = makeTerm(10, 3);

    // Put 2 rows into real scrollback first: rows = 3, so writing 5 lines
    // pushes 2 into scrollback.
    write('one\r\ntwo\r\nthree\r\nfour\r\nfive');
    const scrollbackBefore = grid.scrollback.length;
    expect(scrollbackBefore).toBeGreaterThan(0);

    // Enter alt, then force many scrolls in alt by writing more rows than fit.
    write(ENTER_1049);
    for (let i = 0; i < 50; i++) write(`line${i}\r\n`);

    // While in alt, scrollback must appear empty to the renderer.
    expect(grid.scrollback.length).toBe(0);
    // totalLines while in alt = just the visible rows.
    expect(grid.totalLines()).toBe(grid.rows);

    // Exit. Original scrollback must be intact (no growth).
    write(EXIT_1049);
    expect(grid.scrollback.length).toBe(scrollbackBefore);
  });

  test('writing to main after exit continues from restored cursor', () => {
    const { grid, write } = makeTerm(20, 5);

    write('prefix');
    // Cursor is now at row 0, col 6.
    expect(grid.cursorRow).toBe(0);
    expect(grid.cursorCol).toBe(6);

    write(ENTER_1049);
    write('\x1b[1;1Hjunk');
    write(EXIT_1049);

    // Cursor should be restored to row 0 col 6.
    expect(grid.cursorRow).toBe(0);
    expect(grid.cursorCol).toBe(6);

    // Continue writing; should land after "prefix".
    write('-suffix');
    expect(rowText(grid, 0)).toBe('prefix-suffix');
  });
});

describe('Grid alt-screen legacy modes', () => {
  test('47 swaps buffers without saving or restoring cursor', () => {
    const { grid, write } = makeTerm(20, 5);

    write('main content');
    write('\x1b[3;5H'); // move cursor to (2, 4) zero-based
    expect(grid.cursorRow).toBe(2);
    expect(grid.cursorCol).toBe(4);

    write(ENTER_47);
    expect(grid.inAltScreen).toBe(true);
    // 47 does NOT clear and does NOT save cursor. Cursor stays where it was.
    expect(grid.cursorRow).toBe(2);
    expect(grid.cursorCol).toBe(4);

    // Move cursor in alt.
    write('\x1b[1;1H');
    expect(grid.cursorRow).toBe(0);
    expect(grid.cursorCol).toBe(0);

    write(EXIT_47);
    expect(grid.inAltScreen).toBe(false);
    // 47 does NOT restore cursor: it stays at (0, 0) from the alt-side move.
    expect(grid.cursorRow).toBe(0);
    expect(grid.cursorCol).toBe(0);

    // Main content still intact.
    expect(rowText(grid, 0)).toBe('main content');
  });

  test('1048 saves and restores cursor without buffer swap', () => {
    const { grid, write } = makeTerm(20, 5);

    write('hello');
    write('\x1b[3;7H'); // (2, 6)
    expect(grid.cursorRow).toBe(2);
    expect(grid.cursorCol).toBe(6);

    write(SAVE_1048);
    // No swap occurred.
    expect(grid.inAltScreen).toBe(false);

    // Move cursor away and write, staying on main buffer.
    write('\x1b[5;1Habc');
    expect(grid.cursorRow).toBe(4);
    expect(grid.cursorCol).toBe(3);
    // The write landed on main screen row 4.
    expect(rowText(grid, 4)).toBe('abc');

    write(RESTORE_1048);
    expect(grid.inAltScreen).toBe(false);
    // Cursor restored to (2, 6).
    expect(grid.cursorRow).toBe(2);
    expect(grid.cursorCol).toBe(6);
    // The write we made in between is still on main (no swap).
    expect(rowText(grid, 0)).toBe('hello');
    expect(rowText(grid, 4)).toBe('abc');
  });
});

describe('Grid alt-screen renderer-facing surface', () => {
  test('totalLines and scrollback.length behave correctly in alt mode', () => {
    const { grid, write } = makeTerm(10, 4);
    // Push something into scrollback.
    write('a\r\nb\r\nc\r\nd\r\ne\r\nf');
    expect(grid.scrollback.length).toBeGreaterThan(0);
    const beforeTotal = grid.totalLines();
    expect(beforeTotal).toBe(grid.scrollback.length + grid.rows);

    write(ENTER_1049);
    // In alt, scrollback must look empty and totalLines collapses to rows.
    expect(grid.scrollback.length).toBe(0);
    expect(grid.totalLines()).toBe(grid.rows);

    write(EXIT_1049);
    // Back to main, original scrollback visible again.
    expect(grid.totalLines()).toBe(beforeTotal);
  });
});
