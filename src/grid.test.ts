import { describe, test, expect } from 'bun:test';
import { createHeadless } from './headless.js';
import type { Grid } from './grid.js';
import { PredictionBuffer } from './predict.js';

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

describe('Grid DECCKM (application cursor mode)', () => {
  test('default is false', () => {
    const { grid } = makeTerm();
    expect(grid.applicationCursorMode).toBe(false);
  });

  test('direct setter round-trip', () => {
    const { grid } = makeTerm();
    grid.setApplicationCursorMode(true);
    expect(grid.applicationCursorMode).toBe(true);
    grid.setApplicationCursorMode(false);
    expect(grid.applicationCursorMode).toBe(false);
  });

  test('CSI ?1h sets, CSI ?1l clears', () => {
    const { grid, write } = makeTerm();
    expect(grid.applicationCursorMode).toBe(false);
    write('\x1b[?1h');
    expect(grid.applicationCursorMode).toBe(true);
    write('\x1b[?1l');
    expect(grid.applicationCursorMode).toBe(false);
  });

  test('CSI ?1 h/l does not move the cursor or mark dirty-for-render cells', () => {
    // Pure input-side flag. Writing ?1h should not disturb cursor position
    // or visible screen content, so vim toggling it mid-paint does no harm.
    const { grid, write } = makeTerm(20, 5);
    write('hello');
    expect(grid.cursorCol).toBe(5);
    const before = rowText(grid, 0);
    write('\x1b[?1h');
    expect(grid.cursorCol).toBe(5);
    expect(rowText(grid, 0)).toBe(before);
  });

  test('1049 enter/exit does not reset DECCKM', () => {
    // Alt-screen toggling and DECCKM are orthogonal modes. vim sets both on
    // entry and unsets both on exit, but it does so via separate escape
    // sequences. If the user sets ?1h, then some other app toggles the alt
    // buffer without touching ?1, DECCKM must survive.
    const { grid, write } = makeTerm();
    write('\x1b[?1h');
    expect(grid.applicationCursorMode).toBe(true);
    write(ENTER_1049);
    expect(grid.applicationCursorMode).toBe(true);
    expect(grid.inAltScreen).toBe(true);
    write(EXIT_1049);
    expect(grid.applicationCursorMode).toBe(true);
    expect(grid.inAltScreen).toBe(false);
  });

  test('DECCKM cleared while on alt-screen stays cleared after exit', () => {
    const { grid, write } = makeTerm();
    write('\x1b[?1h');
    write(ENTER_1049);
    write('\x1b[?1l');
    expect(grid.applicationCursorMode).toBe(false);
    write(EXIT_1049);
    expect(grid.applicationCursorMode).toBe(false);
  });

  test('unknown private modes are still silently dropped', () => {
    // Regression: adding ?1 handling must not alter behavior for other
    // modes. Feeding e.g. ?25h (show cursor) should be a no-op for DECCKM.
    const { grid, write } = makeTerm();
    write('\x1b[?25h');
    expect(grid.applicationCursorMode).toBe(false);
  });
});

describe('Grid bracketed paste mode (DEC 2004)', () => {
  test('default is false', () => {
    const { grid } = makeTerm();
    expect(grid.bracketedPasteMode).toBe(false);
  });

  test('direct setter round-trip', () => {
    const { grid } = makeTerm();
    grid.setBracketedPaste(true);
    expect(grid.bracketedPasteMode).toBe(true);
    grid.setBracketedPaste(false);
    expect(grid.bracketedPasteMode).toBe(false);
  });

  test('CSI ?2004h sets, CSI ?2004l clears', () => {
    const { grid, write } = makeTerm();
    expect(grid.bracketedPasteMode).toBe(false);
    write('\x1b[?2004h');
    expect(grid.bracketedPasteMode).toBe(true);
    write('\x1b[?2004l');
    expect(grid.bracketedPasteMode).toBe(false);
  });

  test('CSI ?2004h does not move the cursor or disturb visible cells', () => {
    const { grid, write } = makeTerm(20, 5);
    write('hello');
    const before = rowText(grid, 0);
    const col = grid.cursorCol;
    write('\x1b[?2004h');
    expect(grid.cursorCol).toBe(col);
    expect(rowText(grid, 0)).toBe(before);
  });

  test('bracketed paste and DECCKM are independent modes', () => {
    const { grid, write } = makeTerm();
    write('\x1b[?1h');
    write('\x1b[?2004h');
    expect(grid.applicationCursorMode).toBe(true);
    expect(grid.bracketedPasteMode).toBe(true);
    write('\x1b[?2004l');
    expect(grid.applicationCursorMode).toBe(true);
    expect(grid.bracketedPasteMode).toBe(false);
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

describe('Grid per-line dirty tracking', () => {
  // Drain whatever dirty state has accumulated since creation so tests can
  // reason about a single subsequent mutation in isolation.
  function reset(grid: Grid): void {
    grid.consumeDirty();
  }

  test('writing one character marks exactly one absolute index dirty', () => {
    const { grid, write } = makeTerm(20, 6);
    reset(grid);
    write('x');
    const d = grid.consumeDirty();
    expect(d.dirtyAll).toBe(false);
    // Cursor started at (0,0); writeChar mutates row 0 and moves cursor
    // along the same row. Only row 0 should be dirty.
    const abs = grid.scrollback.length + 0;
    expect([...d.dirtyLines].sort()).toEqual([abs]);
  });

  test('consumeDirty resets the set and the dirtyAll flag', () => {
    const { grid, write } = makeTerm(20, 6);
    write('abc');
    const first = grid.consumeDirty();
    expect(first.dirtyLines.size).toBeGreaterThan(0);
    // Immediately consuming again yields a clean state.
    const second = grid.consumeDirty();
    expect(second.dirtyAll).toBe(false);
    expect(second.dirtyLines.size).toBe(0);
    // And `dirty` is cleared.
    expect(grid.dirty).toBe(false);
  });

  test('scrolling up shifts dirty abs indexes stably (no off-by-one)', () => {
    // A lineFeed at the bottom pushes screen[0] to scrollback and appends
    // a new blank bottom row. Absolute indexes of visible content should
    // stay stable: the row that was screen[1] with abs=S+1 is now
    // screen[0] with abs=(S+1)+0=S+1. The new bottom row is fresh and
    // must be reported dirty under its new abs index.
    const { grid, write } = makeTerm(10, 3);
    // Fill 3 rows without overflowing; cursor ends on row 2.
    write('a\r\nb\r\nc');
    expect(grid.cursorRow).toBe(2);
    expect(grid.scrollback.length).toBe(0);
    reset(grid);

    // LF at bottom -> push to scrollback + new blank bottom row.
    write('\n');
    expect(grid.scrollback.length).toBe(1);
    expect(grid.cursorRow).toBe(2);

    const d = grid.consumeDirty();
    expect(d.dirtyAll).toBe(false);
    // The new bottom row's abs index is scrollback.length + cursorRow
    // = 1 + 2 = 3. That row must be in the dirty set.
    const newBottomAbs = grid.scrollback.length + grid.cursorRow;
    expect(d.dirtyLines.has(newBottomAbs)).toBe(true);
  });

  test('resize marks dirtyAll true', () => {
    const { grid } = makeTerm(20, 6);
    reset(grid);
    grid.resize(30, 8);
    const d = grid.consumeDirty();
    expect(d.dirtyAll).toBe(true);
  });

  test('enterAltScreen marks dirtyAll true', () => {
    const { grid, write } = makeTerm(20, 6);
    reset(grid);
    write(ENTER_1049);
    const d = grid.consumeDirty();
    expect(d.dirtyAll).toBe(true);
  });

  test('exitAltScreen marks dirtyAll true', () => {
    const { grid, write } = makeTerm(20, 6);
    write(ENTER_1049);
    reset(grid);
    write(EXIT_1049);
    const d = grid.consumeDirty();
    expect(d.dirtyAll).toBe(true);
  });

  test('cursor move to a different line marks both old and new lines dirty', () => {
    const { grid, write } = makeTerm(20, 6);
    // Move to a known row first, then consume to clear.
    write('\x1b[3;5H'); // row 2, col 4 (0-based)
    reset(grid);
    const oldRow = grid.cursorRow;
    // Move down one line (same column).
    write('\x1b[B');
    const newRow = grid.cursorRow;
    expect(newRow).toBe(oldRow + 1);
    const d = grid.consumeDirty();
    expect(d.dirtyAll).toBe(false);
    const oldAbs = grid.scrollback.length + oldRow;
    const newAbs = grid.scrollback.length + newRow;
    expect(d.dirtyLines.has(oldAbs)).toBe(true);
    expect(d.dirtyLines.has(newAbs)).toBe(true);
    expect(d.dirtyLines.size).toBe(2);
  });

  test('cursor move within the same line marks only that line dirty', () => {
    const { grid, write } = makeTerm(20, 6);
    write('\x1b[3;5H'); // row 2, col 4
    reset(grid);
    const row = grid.cursorRow;
    // Move forward one column (same row).
    write('\x1b[C');
    expect(grid.cursorRow).toBe(row);
    expect(grid.cursorCol).toBe(5);
    const d = grid.consumeDirty();
    expect(d.dirtyAll).toBe(false);
    const abs = grid.scrollback.length + row;
    expect([...d.dirtyLines]).toEqual([abs]);
  });
});

// Integration: feed ANSI through the real parser into a headless grid while
// reconciling a PredictionBuffer alongside. The reconciliation semantics
// match the ones index.ts installs in the sink wrapper: capture cursor
// before print, call onGridPrint(row, col, ch) after. Cursor-moving ops
// call onGridCursor after mutation.
describe('PredictionBuffer integration with headless grid', () => {
  test("speculative 'a' at (0,5) is consumed when the parser prints 'a' there", () => {
    const h = createHeadless(20, 5, { maxScrollback: 100 });
    const buf = new PredictionBuffer();
    // User typed 'a' while cursor was at (0, 5). Speculation recorded.
    buf.push({ kind: 'print', row: 0, col: 5, ch: 'a', at: 0 });
    expect(buf.size).toBe(1);

    // Server echoes: home cursor, move to column 6 (1-based), print 'a'.
    // Cursor should land at (0, 5) before the print. Reconcile in the order
    // index.ts does: capture before print, then feed and reconcile.
    h.feedString('\x1b[H'); // home
    h.feedString('\x1b[6G'); // column 6 (1-based) => col 5 (0-based)
    expect(h.grid.cursorRow).toBe(0);
    expect(h.grid.cursorCol).toBe(5);

    // Before the parser prints, capture where the cursor is.
    const r = h.grid.cursorRow;
    const c = h.grid.cursorCol;
    h.feedString('a');
    buf.onGridPrint(r, c, 'a');

    expect(buf.size).toBe(0);
    // Grid has the real 'a' at (0, 5).
    expect(h.grid.screen[0]![5]!.ch).toBe('a');
  });

  test("mismatched ch at the predicted (row, col) drops everything", () => {
    const h = createHeadless(20, 5);
    const buf = new PredictionBuffer();
    buf.push({ kind: 'print', row: 0, col: 5, ch: 'a', at: 0 });
    buf.push({ kind: 'cursor', row: 0, col: 6, at: 0 });
    h.feedString('\x1b[H\x1b[6G');
    const r = h.grid.cursorRow;
    const c = h.grid.cursorCol;
    // Server prints 'b' where we predicted 'a'.
    h.feedString('b');
    buf.onGridPrint(r, c, 'b');
    expect(buf.size).toBe(0);
  });
});
