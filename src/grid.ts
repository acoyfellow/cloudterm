// Cell grid + scrollback buffer.
//
// Two regions:
//   scrollback: rows that have scrolled off the top, read-only history.
//   screen:    rows[0..rows-1] that represent the active grid.
//
// Cursor lives inside the screen region. Writes mutate screen rows.
// When LF at the bottom, the top screen row is pushed into scrollback.
//
// Dirty tracking:
//   dirty:      boolean, true if any mutation happened since last consume.
//   dirtyAll:   boolean, true if everything visible must be repainted
//               (resize, alt-screen swap). Overrides dirtyLines.
//   dirtyLines: Set<number> of absolute line indexes that changed since
//               last consume. Absolute index = scrollback.length + screenRow
//               at the time the mutation happened, which stays stable across
//               subsequent scrollback pushes.
//
// The renderer calls consumeDirty() once per paint, which returns and clears
// both dirtyAll and dirtyLines. Cursor moves between lines dirty both old
// and new line; moves within a line dirty just that line. The renderer
// draws the cursor as a surface-level element so same-line moves are cheap
// even though the line is still marked dirty.

import type { CellAttr } from './parser.js';
import { defaultAttr } from './parser.js';

export interface Cell {
  ch: string; // single grapheme or empty
  attr: CellAttr;
}

export function blankCell(): Cell {
  return { ch: ' ', attr: defaultAttr() };
}

export function makeRow(cols: number): Cell[] {
  const r = new Array<Cell>(cols);
  for (let i = 0; i < cols; i++) r[i] = blankCell();
  return r;
}

export interface GridSnapshot {
  scrollbackLen: number;
  screen: Cell[][];
  cursorRow: number;
  cursorCol: number;
  cursorVisible: boolean;
}

export interface DirtyState {
  dirtyAll: boolean;
  dirtyLines: Set<number>;
}

export class Grid {
  cols: number;
  rows: number;
  maxScrollback: number;

  screen: Cell[][] = [];
  scrollback: Cell[][] = [];

  cursorRow = 0;
  cursorCol = 0;
  cursorVisible = true;

  private savedRow = 0;
  private savedCol = 0;

  // Alternate screen buffer state. When inAltScreen is true, `screen` points
  // at the alt buffer and `scrollback` is an empty array. The main-screen
  // buffer + real scrollback are stashed in the `main*` fields until exit.
  inAltScreen = false;
  private altScreen: Cell[][] = [];
  private mainScreen: Cell[][] = [];
  private mainScrollback: Cell[][] = [];
  private altReturnRow = 0;
  private altReturnCol = 0;

  // DECCKM (CSI ?1 h/l). Purely input-side: when true, InputHandler emits
  // `ESC O A/B/C/D` for plain arrow keys instead of `CSI A/B/C/D`. Independent
  // of alt-screen state (1049 does not reset this).
  applicationCursorMode = false;

  dirty = true;
  dirtyAll = true;
  dirtyLines = new Set<number>();

  constructor(cols: number, rows: number, maxScrollback = 10_000) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.maxScrollback = Math.max(0, maxScrollback);
    this.screen = Array.from({ length: this.rows }, () => makeRow(this.cols));
    this.altScreen = Array.from({ length: this.rows }, () => makeRow(this.cols));
  }

  // Absolute line index of the given screen row. Stable reference the renderer
  // uses to key its DOM map.
  private absOf(screenRow: number): number {
    return this.scrollback.length + screenRow;
  }

  private markRow(screenRow: number): void {
    if (screenRow < 0 || screenRow >= this.rows) return;
    this.dirtyLines.add(this.absOf(screenRow));
    this.dirty = true;
  }

  private markRange(rStart: number, rEnd: number): void {
    const a = Math.max(0, rStart);
    const b = Math.min(this.rows - 1, rEnd);
    for (let r = a; r <= b; r++) this.dirtyLines.add(this.absOf(r));
    this.dirty = true;
  }

  private markAllVisible(): void {
    this.dirtyAll = true;
    this.dirty = true;
    // dirtyLines will be ignored while dirtyAll is set; keep it for any
    // caller that wants to union, but don't bother building up a full set.
  }

  // Called around cursor-moving ops. Captures old cursor row, runs the
  // mover, then marks both old and new rows dirty. If the mover itself
  // marked rows, those still stand.
  private withCursorMove(fn: () => void): void {
    const oldRow = this.cursorRow;
    fn();
    // Mark old and new cursor rows dirty so the cursor element can be
    // cleared from the old line and drawn on the new. Renderer still
    // repositions the cursor span at surface level, so same-line moves
    // only rebuild one line, not all visible lines.
    this.markRow(oldRow);
    if (this.cursorRow !== oldRow) this.markRow(this.cursorRow);
  }

  consumeDirty(): DirtyState {
    const state: DirtyState = { dirtyAll: this.dirtyAll, dirtyLines: this.dirtyLines };
    this.dirtyAll = false;
    this.dirtyLines = new Set<number>();
    this.dirty = false;
    return state;
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(1, cols);
    rows = Math.max(1, rows);
    if (cols === this.cols && rows === this.rows) return;

    // Resize whichever buffer is currently active.
    this.resizeBuffer(this.screen, cols, rows, /*pushExcess*/ true);
    // Resize the inactive buffer too, so a later swap sees correct shape.
    // No scrollback push for the inactive buffer.
    const inactive = this.inAltScreen ? this.mainScreen : this.altScreen;
    if (inactive.length) this.resizeBuffer(inactive, cols, rows, /*pushExcess*/ false);

    this.cols = cols;
    this.rows = rows;
    if (this.cursorRow >= rows) this.cursorRow = rows - 1;
    if (this.cursorCol >= cols) this.cursorCol = cols - 1;
    this.markAllVisible();
  }

  private resizeBuffer(
    buf: Cell[][],
    cols: number,
    rows: number,
    pushExcess: boolean,
  ): void {
    for (const row of buf) {
      if (row.length < cols) {
        for (let i = row.length; i < cols; i++) row.push(blankCell());
      } else if (row.length > cols) {
        row.length = cols;
      }
    }
    if (buf.length < rows) {
      while (buf.length < rows) buf.push(makeRow(cols));
    } else if (buf.length > rows) {
      const drop = buf.length - rows;
      for (let i = 0; i < drop; i++) {
        const r = buf.shift();
        if (r && pushExcess) this.pushScrollback(r);
      }
    }
  }

  private pushScrollback(row: Cell[]): void {
    // Alt-screen content never enters scrollback. Application-level scrolling
    // inside less, vim, tmux, etc. must not leak into the user's history.
    if (this.inAltScreen) return;
    if (this.maxScrollback === 0) return;
    this.scrollback.push(row);
    if (this.scrollback.length > this.maxScrollback) {
      const drop = this.scrollback.length - this.maxScrollback;
      this.scrollback.splice(0, drop);
      // Overflow: every previously-tracked dirty absolute index shifted
      // down by `drop`. Rather than rewriting the set, just force a full
      // repaint. This is rare (only when the scrollback cap is reached)
      // and only costs one extra frame.
      if (this.dirtyLines.size > 0) this.markAllVisible();
    }
  }

  // Move cursor absolute
  setCursor(row: number, col: number): void {
    const nr = Math.min(this.rows - 1, Math.max(0, row));
    const nc = Math.min(this.cols - 1, Math.max(0, col));
    // Skip the move entirely if the cursor is already there. Apps often
    // re-send CUP on every redraw and most of them are no-ops.
    if (nr === this.cursorRow && nc === this.cursorCol) return;
    this.withCursorMove(() => {
      this.cursorRow = nr;
      this.cursorCol = nc;
    });
  }

  saveCursor(): void {
    this.savedRow = this.cursorRow;
    this.savedCol = this.cursorCol;
  }
  restoreCursor(): void {
    this.withCursorMove(() => {
      this.cursorRow = Math.min(this.rows - 1, Math.max(0, this.savedRow));
      this.cursorCol = Math.min(this.cols - 1, Math.max(0, this.savedCol));
    });
  }

  writeChar(ch: string, attr: CellAttr): void {
    if (this.cursorCol >= this.cols) this.wrapToNextLine();
    const row = this.screen[this.cursorRow]!;
    // Share the attr object across adjacent cells. Parser owns attr
    // lifecycle: it clones on SGR change and hands a stable reference
    // between changes. Cloning per cell here was burning ~1 allocation
    // per typed character for zero semantic benefit.
    row[this.cursorCol] = { ch, attr };
    // Inline markRow to avoid call overhead in the hot path. writeChar
    // is the single most-frequent mutation in any shell session.
    this.dirtyLines.add(this.scrollback.length + this.cursorRow);
    this.dirty = true;
    this.cursorCol += 1;
  }

  private wrapToNextLine(): void {
    this.cursorCol = 0;
    this.lineFeed();
  }

  carriageReturn(): void {
    // Cursor stays on the same row; mark that row so the cursor span is
    // removed from its old column on rebuild.
    this.markRow(this.cursorRow);
    this.cursorCol = 0;
  }

  lineFeed(): void {
    if (this.cursorRow < this.rows - 1) {
      // Simple move down. Mark both old and new rows for cursor movement.
      this.markRow(this.cursorRow);
      this.cursorRow += 1;
      this.markRow(this.cursorRow);
    } else {
      // Scroll up: top row becomes scrollback, a new blank row appears at
      // the bottom. All visible rows' content moved up one screen slot,
      // but their absolute indexes are stable. The new bottom row is
      // fresh content and the cursor is now on it.
      const gone = this.screen.shift();
      if (gone) this.pushScrollback(gone);
      this.screen.push(makeRow(this.cols));
      // New bottom row's absolute index is the one the cursor is on now.
      this.markRow(this.cursorRow);
    }
    this.dirty = true;
  }

  backspace(): void {
    if (this.cursorCol > 0) {
      this.cursorCol -= 1;
      this.markRow(this.cursorRow);
    }
  }

  tab(): void {
    const next = (Math.floor(this.cursorCol / 8) + 1) * 8;
    this.cursorCol = Math.min(this.cols - 1, next);
    this.markRow(this.cursorRow);
  }

  cursorUp(n: number): void {
    this.withCursorMove(() => {
      this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, n));
    });
  }
  cursorDown(n: number): void {
    this.withCursorMove(() => {
      this.cursorRow = Math.min(this.rows - 1, this.cursorRow + Math.max(1, n));
    });
  }
  cursorForward(n: number): void {
    this.withCursorMove(() => {
      this.cursorCol = Math.min(this.cols - 1, this.cursorCol + Math.max(1, n));
    });
  }
  cursorBack(n: number): void {
    this.withCursorMove(() => {
      this.cursorCol = Math.max(0, this.cursorCol - Math.max(1, n));
    });
  }

  eraseInDisplay(mode: number): void {
    // 0: cursor to end; 1: start to cursor; 2/3: entire screen
    if (mode === 2 || mode === 3) {
      for (let r = 0; r < this.rows; r++) this.screen[r] = makeRow(this.cols);
      this.markRange(0, this.rows - 1);
    } else if (mode === 1) {
      for (let r = 0; r < this.cursorRow; r++) this.screen[r] = makeRow(this.cols);
      const row = this.screen[this.cursorRow]!;
      for (let c = 0; c <= this.cursorCol && c < this.cols; c++) row[c] = blankCell();
      this.markRange(0, this.cursorRow);
    } else {
      const row = this.screen[this.cursorRow]!;
      for (let c = this.cursorCol; c < this.cols; c++) row[c] = blankCell();
      for (let r = this.cursorRow + 1; r < this.rows; r++) this.screen[r] = makeRow(this.cols);
      this.markRange(this.cursorRow, this.rows - 1);
    }
  }

  eraseInLine(mode: number): void {
    const row = this.screen[this.cursorRow]!;
    if (mode === 1) {
      for (let c = 0; c <= this.cursorCol && c < this.cols; c++) row[c] = blankCell();
    } else if (mode === 2) {
      for (let c = 0; c < this.cols; c++) row[c] = blankCell();
    } else {
      for (let c = this.cursorCol; c < this.cols; c++) row[c] = blankCell();
    }
    this.markRow(this.cursorRow);
  }

  scrollUp(n: number): void {
    n = Math.max(1, n);
    for (let i = 0; i < n; i++) {
      const gone = this.screen.shift();
      if (gone) this.pushScrollback(gone);
      this.screen.push(makeRow(this.cols));
    }
    // All visible rows' content shifted but absolute indexes are stable;
    // content at each visible absolute index changed, so mark them all.
    this.markRange(0, this.rows - 1);
  }
  scrollDown(n: number): void {
    n = Math.max(1, n);
    for (let i = 0; i < n; i++) {
      this.screen.pop();
      this.screen.unshift(makeRow(this.cols));
    }
    this.markRange(0, this.rows - 1);
  }

  totalLines(): number {
    return this.scrollback.length + this.rows;
  }

  getLine(index: number): Cell[] {
    if (index < this.scrollback.length) return this.scrollback[index]!;
    const r = this.screen[index - this.scrollback.length];
    return r ?? makeRow(this.cols);
  }

  clearScrollback(): void {
    this.scrollback = [];
    // All visible-line absolute indexes just shifted down. Safest to repaint.
    this.markAllVisible();
  }

  // Alternate screen buffer support (xterm DEC private modes 47/1047/1048/1049).
  //
  // enter(save, clear): switch to alt. If save, stash cursor for later restore.
  // If clear, blank the alt buffer on entry.
  // exit(clear, restore): switch back. If clear, blank alt before swap. If
  // restore, put cursor back where it was when we entered.
  //
  // 1049 = enter(save=true, clear=true), exit(clear=true, restore=true).
  // 1047 = enter(save=false, clear=false), exit(clear=true, restore=false).
  //   47  = enter(save=false, clear=false), exit(clear=false, restore=false).

  enterAltScreen(save: boolean, clear: boolean): void {
    if (this.inAltScreen) {
      if (clear) this.blankBuffer(this.screen);
      if (save) {
        this.altReturnRow = this.cursorRow;
        this.altReturnCol = this.cursorCol;
      }
      this.markAllVisible();
      return;
    }
    if (save) {
      this.altReturnRow = this.cursorRow;
      this.altReturnCol = this.cursorCol;
    }
    // Stash main, swap alt in.
    this.mainScreen = this.screen;
    this.mainScrollback = this.scrollback;
    this.screen = this.altScreen;
    this.scrollback = [];
    this.inAltScreen = true;
    if (clear) this.blankBuffer(this.screen);
    this.markAllVisible();
  }

  exitAltScreen(clear: boolean, restore: boolean): void {
    if (!this.inAltScreen) {
      if (restore) {
        this.withCursorMove(() => {
          this.cursorRow = Math.min(this.rows - 1, Math.max(0, this.altReturnRow));
          this.cursorCol = Math.min(this.cols - 1, Math.max(0, this.altReturnCol));
        });
      }
      return;
    }
    if (clear) this.blankBuffer(this.screen);
    // Swap back.
    this.altScreen = this.screen;
    this.screen = this.mainScreen;
    this.scrollback = this.mainScrollback;
    this.mainScreen = [];
    this.mainScrollback = [];
    this.inAltScreen = false;
    if (restore) {
      this.cursorRow = Math.min(this.rows - 1, Math.max(0, this.altReturnRow));
      this.cursorCol = Math.min(this.cols - 1, Math.max(0, this.altReturnCol));
    }
    this.markAllVisible();
  }

  // Save/restore cursor pair used by CSI ?1048. Independent of the buffer swap.
  saveCursorAlt(): void {
    this.altReturnRow = this.cursorRow;
    this.altReturnCol = this.cursorCol;
  }
  restoreCursorAlt(): void {
    this.withCursorMove(() => {
      this.cursorRow = Math.min(this.rows - 1, Math.max(0, this.altReturnRow));
      this.cursorCol = Math.min(this.cols - 1, Math.max(0, this.altReturnCol));
    });
  }

  private blankBuffer(buf: Cell[][]): void {
    for (let r = 0; r < buf.length; r++) buf[r] = makeRow(this.cols);
  }

  // DECCKM setter. No dirty flag: input-only, renderer doesn't care.
  setApplicationCursorMode(enabled: boolean): void {
    this.applicationCursorMode = enabled;
  }
}
