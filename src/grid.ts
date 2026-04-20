// Cell grid + scrollback buffer.
//
// Two regions:
//   scrollback: rows that have scrolled off the top, read-only history.
//   screen:    rows[0..rows-1] that represent the active grid.
//
// Cursor lives inside the screen region. Writes mutate screen rows.
// When LF at the bottom, the top screen row is pushed into scrollback.

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

  dirty = true;

  constructor(cols: number, rows: number, maxScrollback = 10_000) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.maxScrollback = Math.max(0, maxScrollback);
    this.screen = Array.from({ length: this.rows }, () => makeRow(this.cols));
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(1, cols);
    rows = Math.max(1, rows);
    if (cols === this.cols && rows === this.rows) return;

    // Naive: resize each row to new cols.
    for (const row of this.screen) {
      if (row.length < cols) {
        for (let i = row.length; i < cols; i++) row.push(blankCell());
      } else if (row.length > cols) {
        row.length = cols;
      }
    }
    // Adjust row count
    if (this.screen.length < rows) {
      while (this.screen.length < rows) this.screen.push(makeRow(cols));
    } else if (this.screen.length > rows) {
      // Push excess top rows into scrollback
      const drop = this.screen.length - rows;
      for (let i = 0; i < drop; i++) {
        const r = this.screen.shift();
        if (r) this.pushScrollback(r);
      }
    }
    // Also make sure scrollback rows respect new cols (optional, keep stable).
    this.cols = cols;
    this.rows = rows;
    if (this.cursorRow >= rows) this.cursorRow = rows - 1;
    if (this.cursorCol >= cols) this.cursorCol = cols - 1;
    this.dirty = true;
  }

  private pushScrollback(row: Cell[]): void {
    if (this.maxScrollback === 0) return;
    this.scrollback.push(row);
    if (this.scrollback.length > this.maxScrollback) {
      this.scrollback.splice(0, this.scrollback.length - this.maxScrollback);
    }
  }

  // Move cursor absolute
  setCursor(row: number, col: number): void {
    this.cursorRow = Math.min(this.rows - 1, Math.max(0, row));
    this.cursorCol = Math.min(this.cols - 1, Math.max(0, col));
  }

  saveCursor(): void {
    this.savedRow = this.cursorRow;
    this.savedCol = this.cursorCol;
  }
  restoreCursor(): void {
    this.cursorRow = Math.min(this.rows - 1, Math.max(0, this.savedRow));
    this.cursorCol = Math.min(this.cols - 1, Math.max(0, this.savedCol));
  }

  writeChar(ch: string, attr: CellAttr): void {
    if (this.cursorCol >= this.cols) this.wrapToNextLine();
    const row = this.screen[this.cursorRow]!;
    row[this.cursorCol] = { ch, attr: { ...attr } };
    this.cursorCol += 1;
    this.dirty = true;
  }

  private wrapToNextLine(): void {
    this.cursorCol = 0;
    this.lineFeed();
  }

  carriageReturn(): void {
    this.cursorCol = 0;
    this.dirty = true;
  }

  lineFeed(): void {
    if (this.cursorRow < this.rows - 1) {
      this.cursorRow += 1;
    } else {
      // scroll up
      const gone = this.screen.shift();
      if (gone) this.pushScrollback(gone);
      this.screen.push(makeRow(this.cols));
    }
    this.dirty = true;
  }

  backspace(): void {
    if (this.cursorCol > 0) {
      this.cursorCol -= 1;
      this.dirty = true;
    }
  }

  tab(): void {
    const next = (Math.floor(this.cursorCol / 8) + 1) * 8;
    this.cursorCol = Math.min(this.cols - 1, next);
    this.dirty = true;
  }

  cursorUp(n: number): void {
    this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, n));
    this.dirty = true;
  }
  cursorDown(n: number): void {
    this.cursorRow = Math.min(this.rows - 1, this.cursorRow + Math.max(1, n));
    this.dirty = true;
  }
  cursorForward(n: number): void {
    this.cursorCol = Math.min(this.cols - 1, this.cursorCol + Math.max(1, n));
    this.dirty = true;
  }
  cursorBack(n: number): void {
    this.cursorCol = Math.max(0, this.cursorCol - Math.max(1, n));
    this.dirty = true;
  }

  eraseInDisplay(mode: number): void {
    // 0: cursor to end; 1: start to cursor; 2/3: entire screen
    if (mode === 2 || mode === 3) {
      for (let r = 0; r < this.rows; r++) this.screen[r] = makeRow(this.cols);
    } else if (mode === 1) {
      for (let r = 0; r < this.cursorRow; r++) this.screen[r] = makeRow(this.cols);
      const row = this.screen[this.cursorRow]!;
      for (let c = 0; c <= this.cursorCol && c < this.cols; c++) row[c] = blankCell();
    } else {
      const row = this.screen[this.cursorRow]!;
      for (let c = this.cursorCol; c < this.cols; c++) row[c] = blankCell();
      for (let r = this.cursorRow + 1; r < this.rows; r++) this.screen[r] = makeRow(this.cols);
    }
    this.dirty = true;
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
    this.dirty = true;
  }

  scrollUp(n: number): void {
    n = Math.max(1, n);
    for (let i = 0; i < n; i++) {
      const gone = this.screen.shift();
      if (gone) this.pushScrollback(gone);
      this.screen.push(makeRow(this.cols));
    }
    this.dirty = true;
  }
  scrollDown(n: number): void {
    n = Math.max(1, n);
    for (let i = 0; i < n; i++) {
      this.screen.pop();
      this.screen.unshift(makeRow(this.cols));
    }
    this.dirty = true;
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
    this.dirty = true;
  }
}
