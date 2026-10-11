import { describe, test, expect } from 'bun:test';
import { createHeadless } from './headless.js';
import { Grid } from './grid.js';
import { defaultAttr } from './parser.js';
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

describe('Grid cell isolation', () => {
  test('writing replaces a shared blank without changing other blanks', () => {
    const grid = new Grid(3, 1);
    const neighbour = grid.screen[0]![1]!;
    const freshGrid = new Grid(3, 1);
    grid.writeChar('x', defaultAttr());
    expect(grid.screen[0]![0]!.ch).toBe('x');
    expect(grid.screen[0]![1]!).toBe(neighbour);
    expect(grid.screen[0]![1]!.ch).toBe(' ');
    expect(freshGrid.screen[0]![0]!.ch).toBe(' ');
  });
});

describe('Grid Unicode cells', () => {
  test('stores wide characters in two cells', () => {
    const { grid, write } = makeTerm(8, 2);
    write('日本');
    expect(grid.cursorCol).toBe(4);
    expect(grid.screen[0]![1]!.ch).toBe('');
    expect(grid.screen[0]![3]!.ch).toBe('');
  });

  test('wraps a wide character from the last column after padding it', () => {
    const { grid, write } = makeTerm(3, 2);
    write('ab日');
    expect(grid.screen[0]![2]!.ch).toBe(' ');
    expect(grid.screen[1]![0]!.ch).toBe('日');
    expect(grid.screen[1]![1]!.ch).toBe('');
  });

  test('overwriting a continuation clears the wide character', () => {
    const { grid, write } = makeTerm(5, 2);
    write('日');
    grid.setCursor(0, 1);
    write('x');
    expect(grid.screen[0]![0]!.ch).toBe(' ');
    expect(grid.screen[0]![1]!.ch).toBe('x');
  });

  test('appends combining marks to the preceding cell', () => {
    const { grid, write } = makeTerm(5, 2);
    write('e\u0301');
    expect(grid.cursorCol).toBe(1);
    expect(grid.screen[0]![0]!.ch).toBe('e\u0301');
  });
});

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

describe('Grid DEC private modes and deferred wrap', () => {
  test('CSI ?25 toggles cursor visibility and dirties its row', () => {
    const { grid, write } = makeTerm();
    grid.consumeDirty();
    write('\x1b[?25l');
    expect(grid.cursorVisible).toBe(false);
    expect(grid.consumeDirty().dirtyLines).toEqual(new Set([0]));
    write('\x1b[?25h');
    expect(grid.cursorVisible).toBe(true);
  });

  test('CSI ?7l overwrites the last column', () => {
    const { grid, write } = makeTerm(3, 2);
    write('\x1b[?7labcZ');
    expect(rowText(grid, 0)).toBe('abZ');
    expect(grid.cursorRow).toBe(0);
    expect(grid.cursorCol).toBe(2);
  });

  test('defers wrapping until the next printable character', () => {
    const { grid, write } = makeTerm(3, 2);
    write('abc');
    expect(grid.cursorRow).toBe(0);
    expect(grid.cursorCol).toBe(2);
    write('d');
    expect(rowText(grid, 0)).toBe('abc');
    expect(rowText(grid, 1)).toBe('d');
    expect(grid.cursorRow).toBe(1);
    expect(grid.cursorCol).toBe(1);
  });

  test('carriage return clears a pending wrap', () => {
    const { grid, write } = makeTerm(3, 2);
    write('abc\rZ');
    expect(rowText(grid, 0)).toBe('Zbc');
    expect(rowText(grid, 1)).toBe('');
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

describe('Grid scroll region and line editing', () => {
  const text = (g: Grid) => {
    const out: string[] = [];
    for (let r = 0; r < g.rows; r++) out.push(g.getLine(g.scrollback.length + r).map((c) => c.ch).join('').trimEnd());
    return out;
  };
  const fill = (g: Grid, lines: string[]) => {
    lines.forEach((line, r) => {
      g.setCursor(r, 0);
      for (const ch of line) g.writeChar(ch, defaultAttr());
    });
  };

  test('line feed at the region bottom scrolls only the region', () => {
    const g = new Grid(4, 4, 100);
    fill(g, ['a', 'b', 'c', 'd']);
    g.setScrollRegion(1, 2);
    g.setCursor(2, 0);
    g.lineFeed();
    expect(text(g)).toEqual(['a', 'c', '', 'd']);
    expect(g.scrollback.length).toBe(0);
  });

  test('insert and delete lines stay inside the region', () => {
    const g = new Grid(4, 4, 100);
    fill(g, ['a', 'b', 'c', 'd']);
    g.setCursor(1, 0);
    g.insertLines(1);
    expect(text(g)).toEqual(['a', '', 'b', 'c']);
    g.deleteLines(2);
    expect(text(g)).toEqual(['a', 'c', '', '']);
  });

  test('insert, delete, and erase characters', () => {
    const g = new Grid(6, 1, 0);
    fill(g, ['abcdef']);
    g.setCursor(0, 2);
    g.deleteChars(2);
    expect(text(g)).toEqual(['abef']);
    g.insertChars(1);
    expect(text(g)).toEqual(['ab ef']);
    g.setCursor(0, 0);
    g.eraseChars(2);
    expect(text(g)).toEqual(['   ef']);
  });

  test('reverse index at the region top scrolls the region down', () => {
    const g = new Grid(4, 3, 0);
    fill(g, ['a', 'b', 'c']);
    g.setCursor(0, 0);
    g.reverseIndex();
    expect(text(g)).toEqual(['', 'a', 'b']);
  });
});

describe('Grid cell interning', () => {
  test('repeated ascii cells with one attr share a frozen cell', () => {
    const grid = new Grid(4, 1);
    const attr = defaultAttr();
    grid.writeChar('a', attr);
    grid.writeChar('a', attr);
    grid.writeChar('b', attr);
    const row = grid.screen[0]!;
    expect(row[0]).toBe(row[1]);
    expect(row[0]).not.toBe(row[2]);
    expect(Object.isFrozen(row[0])).toBe(true);
    grid.writeChar('\u0301', attr);
    expect(row[2]!.ch).toBe('b\u0301');
    expect(row[0]!.ch).toBe('a');
  });
});
