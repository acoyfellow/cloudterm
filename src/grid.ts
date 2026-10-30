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
import { DEFAULT_ATTR } from './parser.js';
import { wcwidth } from './wcwidth.js';

export interface Cell {
  ch: string; // single grapheme or empty
  attr: CellAttr;
}

const BLANK = Object.freeze({ ch: ' ', attr: DEFAULT_ATTR });
const cellCache = new WeakMap<CellAttr, Cell[]>();

function internCell(ch: string, attr: CellAttr): Cell {
  const code = ch.length === 1 ? ch.charCodeAt(0) : 128;
  return code < 128 ? (asciiCells(attr)[code] ??= Object.freeze({ ch, attr })) : { ch, attr };
}

let lastAttr: CellAttr | null = null;
let lastCells: Cell[] = [];

function asciiCells(attr: CellAttr): Cell[] {
  if (attr === lastAttr) return lastCells;
  let cells = cellCache.get(attr);
  if (!cells) {
    cells = [];
    cellCache.set(attr, cells);
  }
  lastAttr = attr;
  lastCells = cells;
  return cells;
}

export function blankCell(): Cell {
  return BLANK;
}

const CHAR_BITS = 21;
const CHAR_MASK = (1 << CHAR_BITS) - 1;
const CONTINUATION = 0;

export class Row {
  codes: Uint32Array;
  constructor(cols: number) { this.codes = new Uint32Array(cols); this.codes.fill(32); }
}

export function makeRow(cols: number): Row {
  return new Row(cols);
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

interface SerializedSnapshot {
  v: 1;
  cols: number;
  rows: number;
  cursor: [number, number];
  modes: { applicationCursor: boolean; bracketedPaste: boolean; autowrap: boolean; mouseTracking: 0 | 9 | 1000 | 1002 | 1003; mouseSgr: boolean };
  scrollback: number[];
  screen: number[];
  lines: SerializedLine[];
  attrs: CellAttr[];
  trimmed: number;
  alt?: boolean;
}

type SerializedLine = Array<[string, number]>;

export class RingBuffer<T> {
  private values: (T | undefined)[];
  private start = 0;
  length = 0;

  constructor(private readonly capacity: number) {
    this.values = new Array<T | undefined>(capacity);
  }

  evicted: T | undefined;

  push(value: T): boolean {
    this.evicted = undefined;
    if (this.capacity === 0) return false;
    const full = this.length === this.capacity;
    const index = (this.start + this.length) % this.capacity;
    if (full) this.evicted = this.values[index];
    this.values[index] = value;
    if (full) this.start = (this.start + 1) % this.capacity;
    else this.length += 1;
    return full;
  }

  get(index: number): T | undefined {
    if (index < 0 || index >= this.length) return undefined;
    return this.values[(this.start + index) % this.capacity];
  }

  clear(): void {
    this.values.fill(undefined);
    this.start = 0;
    this.length = 0;
  }
}

export class Grid {
  cols: number;
  rows: number;
  maxScrollback: number;

  private rowsData: Row[] = [];
  scrollback: RingBuffer<Row>;
  trimmed = 0;

  cursorRow = 0;
  cursorCol = 0;
  cursorVisible = true;
  autoWrapMode = true;
  private pendingWrap = false;

  private savedRow = 0;
  private savedCol = 0;

  scrollTop = 0;
  scrollBottom = 0;

  // Alternate screen buffer state. When inAltScreen is true, `screen` points
  // at the alt buffer and `scrollback` is an empty array. The main-screen
  // buffer + real scrollback are stashed in the `main*` fields until exit.
  inAltScreen = false;
  private altScreen: Row[] = [];
  private mainScreen: Row[] = [];
  private mainScrollback: RingBuffer<Row> | null = null;
  private mainTrimmed = 0;
  private altReturnRow = 0;
  private altReturnCol = 0;

  // DECCKM (CSI ?1 h/l). Purely input-side: when true, InputHandler emits
  // `ESC O A/B/C/D` for plain arrow keys instead of `CSI A/B/C/D`. Independent
  // of alt-screen state (1049 does not reset this).
  applicationCursorMode = false;

  // Bracketed paste (CSI ?2004 h/l). Purely input-side: when true, pasted
  // text from the clipboard is wrapped with ESC [ 200 ~ and ESC [ 201 ~ so
  // the shell can distinguish it from keystrokes. No rendering effect.
  bracketedPasteMode = false;
  mouseTracking: 0 | 9 | 1000 | 1002 | 1003 = 0;
  mouseSgr = false;

  dirty = true;
  dirtyAll = true;
  dirtyLines = new Set<number>();
  private dirtyRows: Uint32Array;
  private tick = 1;
  private skip = false;

  constructor(cols: number, rows: number, maxScrollback = 10_000) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.maxScrollback = Math.max(0, maxScrollback);
    this.scrollback = new RingBuffer<Row>(this.maxScrollback);
    this.rowsData = Array.from({ length: this.rows }, () => makeRow(this.cols));
    this.altScreen = Array.from({ length: this.rows }, () => makeRow(this.cols));
    this.dirtyRows = new Uint32Array(this.rows);
    this.scrollBottom = this.rows - 1;
  }

  private attrIndexes = new Map<CellAttr, number>([[DEFAULT_ATTR, 0]]);
  private attrs: CellAttr[] = [DEFAULT_ATTR];
  private strings: string[] = [];
  private stringIndexes = new Map<string, number>();

  private code(cell: Cell): number {
    let attr = this.attrIndexes.get(cell.attr);
    if (attr === undefined) { attr = this.attrs.length; this.attrs.push(cell.attr); this.attrIndexes.set(cell.attr, attr); }
    let ch: number;
    if (cell.ch === '') ch = CONTINUATION;
    else if (cell.ch.length === 1 && cell.ch.charCodeAt(0) < 128) ch = cell.ch.charCodeAt(0);
    else { let i = this.stringIndexes.get(cell.ch); if (i === undefined) { i = this.strings.length; this.strings.push(cell.ch); this.stringIndexes.set(cell.ch, i); } ch = 128 + i; }
    return (attr << CHAR_BITS) | ch;
  }

  private isWideAt(row: Row, col: number): boolean { const ch = this.cellAt(row, col).ch; return ch > '~' && wcwidth(ch) === 2; }

  cellAt(row: Row, col: number): Cell {
    const code = row.codes[col]!;
    const ch = (code & CHAR_MASK) === CONTINUATION ? '' : (code & CHAR_MASK) < 128 ? String.fromCharCode(code & CHAR_MASK) : this.strings[(code & CHAR_MASK) - 128]!;
    return internCell(ch, this.attrs[code >>> CHAR_BITS]!);
  }

  setCell(row: Row, col: number, cell: Cell): void { row.codes[col] = this.code(cell); }
  fillRow(row: Row, cell = BLANK): void { row.codes.fill(this.code(cell)); }
  private cells(row: Row): Cell[] { return Array.from(row.codes, (_, col) => this.cellAt(row, col)); }
  private rowFrom(cells: Cell[]): Row { const row = makeRow(cells.length); for (let i = 0; i < cells.length; i++) this.setCell(row, i, cells[i]!); return row; }

  get screen(): Cell[][] {
    const rows = this.rowsData.map((row) => new Proxy(this.cells(row), { get: (target, key, receiver) => { if (typeof key === 'string' && /^\d+$/.test(key)) return this.cellAt(row, Number(key)); return Reflect.get(target, key, receiver); }, set: (target, key, value) => { if (typeof key === 'string' && /^\d+$/.test(key)) { this.setCell(row, Number(key), value as Cell); return true; } return Reflect.set(target, key, value); } }));
    return new Proxy(rows, { set: (target, key, value) => { if (typeof key === 'string' && /^\d+$/.test(key)) { this.rowsData[Number(key)] = this.rowFrom(value as Cell[]); return true; } return Reflect.set(target, key, value); } });
  }
  set screen(value: Cell[][]) { this.rowsData = value.map((row) => this.rowFrom(row)); }

  private get regionIsFullScreen(): boolean {
    return this.scrollTop === 0 && this.scrollBottom === this.rows - 1;
  }

  setScrollRegion(top: number, bottom: number): void {
    const t = Math.max(0, Math.min(this.rows - 1, top));
    const b = Math.max(0, Math.min(this.rows - 1, bottom));
    if (t >= b) {
      this.scrollTop = 0;
      this.scrollBottom = this.rows - 1;
    } else {
      this.scrollTop = t;
      this.scrollBottom = b;
    }
    this.setCursorForced(0, 0);
  }

  private setCursorForced(row: number, col: number): void {
    this.clearPendingWrap();
    this.withCursorMove(() => {
      this.cursorRow = Math.min(this.rows - 1, Math.max(0, row));
      this.cursorCol = Math.min(this.cols - 1, Math.max(0, col));
    });
  }

  private scrollRegionUp(top: number, bottom: number, n: number): void {
    const count = Math.min(n, bottom - top + 1);
    for (let i = 0; i < count; i++) {
      const [gone] = this.rowsData.splice(top, 1);
      if (gone && top === 0 && bottom === this.rows - 1) this.pushScrollback(gone);
      this.rowsData.splice(bottom, 0, makeRow(this.cols));
    }
    this.markRange(top, bottom);
  }

  private scrollRegionDown(top: number, bottom: number, n: number): void {
    const count = Math.min(n, bottom - top + 1);
    for (let i = 0; i < count; i++) {
      this.rowsData.splice(bottom, 1);
      this.rowsData.splice(top, 0, makeRow(this.cols));
    }
    this.markRange(top, bottom);
  }

  cursorRowAbsolute(row: number): void {
    this.setCursorForced(row, this.cursorCol);
  }

  insertLines(n: number): void {
    this.clearPendingWrap();
    if (this.cursorRow < this.scrollTop || this.cursorRow > this.scrollBottom) return;
    this.scrollRegionDown(this.cursorRow, this.scrollBottom, Math.max(1, n));
    this.cursorCol = 0;
  }

  deleteLines(n: number): void {
    this.clearPendingWrap();
    if (this.cursorRow < this.scrollTop || this.cursorRow > this.scrollBottom) return;
    const count = Math.min(Math.max(1, n), this.scrollBottom - this.cursorRow + 1);
    for (let i = 0; i < count; i++) {
      this.rowsData.splice(this.cursorRow, 1);
      this.rowsData.splice(this.scrollBottom, 0, makeRow(this.cols));
    }
    this.markRange(this.cursorRow, this.scrollBottom);
    this.cursorCol = 0;
  }

  insertChars(n: number): void {
    const row = this.rowsData[this.cursorRow]!;
    const col = Math.min(this.cursorCol, this.cols - 1);
    const count = Math.min(Math.max(1, n), this.cols - col);
    row.codes.copyWithin(col + count, col, this.cols - count);
    row.codes.fill(this.code(BLANK), col, col + count);
    this.normalizeRow(row);
    this.markRow(this.cursorRow);
  }

  deleteChars(n: number): void {
    const row = this.rowsData[this.cursorRow]!;
    const col = Math.min(this.cursorCol, this.cols - 1);
    const count = Math.min(Math.max(1, n), this.cols - col);
    row.codes.copyWithin(col, col + count);
    row.codes.fill(this.code(BLANK), this.cols - count);
    this.normalizeRow(row);
    this.markRow(this.cursorRow);
  }

  eraseChars(n: number): void {
    this.clearPendingWrap();
    const row = this.rowsData[this.cursorRow]!;
    const col = Math.min(this.cursorCol, this.cols - 1);
    const end = Math.min(this.cols, col + Math.max(1, n));
    for (let c = col; c < end; c++) this.clearCell(row, c);
    this.markRow(this.cursorRow);
  }

  reverseIndex(): void {
    if (this.cursorRow === this.scrollTop) this.scrollRegionDown(this.scrollTop, this.scrollBottom, 1);
    else this.cursorUp(1);
  }

  // Absolute line index of the given screen row. Stable reference the renderer
  // uses to key its DOM map.
  private absOf(screenRow: number): number {
    return this.trimmed + this.scrollback.length + screenRow;
  }

  private markRow(screenRow: number): void {
    if (screenRow < 0 || screenRow >= this.rows) return;
    if (!this.skip && this.dirtyRows[screenRow] !== this.tick) {
      this.dirtyRows[screenRow] = this.tick;
      this.dirtyLines.add(this.absOf(screenRow));
    }
    this.dirty = true;
  }

  private markRange(rStart: number, rEnd: number): void {
    for (let r = Math.max(0, rStart); r <= rEnd; r++) this.markRow(r);
  }

  private pruneDirty(): void {
    const top = this.absOf(0);
    for (const line of this.dirtyLines) if (line < top) this.dirtyLines.delete(line);
  }

  private markAllVisible(): void {
    this.dirtyAll = true;
    this.dirtyLines.clear();
    this.skip = true;
    this.dirty = true;
  }

  // Called around cursor-moving ops. Captures old cursor row, runs the
  // mover, then marks both old and new rows dirty. If the mover itself
  // marked rows, those still stand.
  private withCursorMove(fn: () => void): void {
    this.clearPendingWrap();
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
    this.skip = false;
    this.dirty = false;
    this.tick += 1;
    if (this.tick === 0) {
      this.dirtyRows.fill(0);
      this.tick = 1;
    }
    return state;
  }

  resize(cols: number, rows: number): void {
    this.clearPendingWrap();
    cols = Math.max(1, cols);
    rows = Math.max(1, rows);
    if (cols === this.cols && rows === this.rows) return;

    // Resize whichever buffer is currently active.
    this.resizeBuffer(this.rowsData, cols, rows, true);
    // Resize the inactive buffer too, so a later swap sees correct shape.
    // No scrollback push for the inactive buffer.
    const inactive = this.inAltScreen ? this.mainScreen : this.altScreen;
    if (inactive.length) this.resizeBuffer(inactive, cols, rows, /*pushExcess*/ false);

    this.cols = cols;
    this.rows = rows;
    this.dirtyRows = new Uint32Array(rows);
    this.tick = 1;
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    if (this.cursorRow >= rows) this.cursorRow = rows - 1;
    if (this.cursorCol >= cols) this.cursorCol = cols - 1;
    this.markAllVisible();
  }

  private resizeBuffer(
    buf: Row[],
    cols: number,
    rows: number,
    pushExcess: boolean,
  ): void {
    for (const row of buf) {
      if (row.codes.length !== cols) {
        const codes = new Uint32Array(cols);
        codes.fill(this.code(BLANK));
        codes.set(row.codes.subarray(0, cols));
        row.codes = codes;
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

  private freshRow(gone: Row | undefined): Row {
    const recycled = gone && this.pushScrollback(gone);
    if (recycled?.codes.length === this.cols) { this.fillRow(recycled); return recycled; }
    return makeRow(this.cols);
  }

  private pushScrollback(row: Row): Row | undefined {
    if (this.inAltScreen || this.maxScrollback === 0) return undefined;
    if (!this.scrollback.push(row)) return undefined;
    this.trimmed += 1;
    return this.scrollback.evicted;
  }

  private clearPendingWrap(): void {
    this.pendingWrap = false;
  }

  // Move cursor absolute
  setCursor(row: number, col: number): void {
    const nr = Math.min(this.rows - 1, Math.max(0, row));
    const nc = Math.min(this.cols - 1, Math.max(0, col));
    if (nr === this.cursorRow && nc === this.cursorCol) this.clearPendingWrap();
    else this.setCursorForced(nr, nc);
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

  writeAscii(text: string, attr: CellAttr): void {
    const attrCode = this.code({ ch: ' ', attr }) & ~CHAR_MASK;
    let index = 0;
    while (index < text.length) {
      if (this.pendingWrap) this.wrapToNextLine();
      const row = this.rowsData[this.cursorRow]!;
      const start = this.cursorCol;
      const end = Math.min(this.cols, start + text.length - index);
      if (this.cellAt(row, start).ch === '' || this.isWideAt(row, start)) this.clearCell(row, start);
      if (end < this.cols && this.cellAt(row, end).ch === '') this.setCell(row, end, BLANK);
      for (let col = start; col < end; col++, index++) { const ch = text[index]!; const code = ch.charCodeAt(0); if (code < 128) row.codes[col] = attrCode | code; else this.setCell(row, col, internCell(ch, attr)); }
      this.markRow(this.cursorRow);
      this.cursorCol = Math.min(end, this.cols - 1);
      if (end === this.cols) {
        this.pendingWrap = this.autoWrapMode;
        if (!this.autoWrapMode && index < text.length) {
          const ch = text[text.length - 1]!;
          if (ch.charCodeAt(0) < 128) row.codes[end - 1] = attrCode | ch.charCodeAt(0);
          else this.setCell(row, end - 1, internCell(ch, attr));
          return;
        }
      }
    }
  }

  writeChar(ch: string, attr: CellAttr): void {
    const width = wcwidth(ch);
    if (width === 0) {
      this.appendCombining(ch);
      return;
    }
    if (this.pendingWrap) this.wrapToNextLine();
    if (width === 2 && this.cursorCol === this.cols - 1) {
      const row = this.rowsData[this.cursorRow]!;
      this.clearCell(row, this.cursorCol);
      this.markRow(this.cursorRow);
      if (!this.autoWrapMode) return;
      this.wrapToNextLine();
    }
    const row = this.rowsData[this.cursorRow]!;
    this.clearCell(row, this.cursorCol);
    this.setCell(row, this.cursorCol, internCell(ch, attr));
    if (width === 2) {
      this.clearCell(row, this.cursorCol + 1);
      this.setCell(row, this.cursorCol + 1, { ch: '', attr });
    }
    this.markRow(this.cursorRow);
    const next = this.cursorCol + width;
    if (next >= this.cols) {
      this.cursorCol = this.cols - 1;
      this.pendingWrap = this.autoWrapMode;
    } else {
      this.cursorCol = next;
    }
  }

  private appendCombining(ch: string): void {
    const row = this.rowsData[this.cursorRow]!;
    let col = this.pendingWrap ? this.cols - 1 : this.cursorCol - 1;
    if (col < 0) return;
    if (this.cellAt(row, col).ch === '') col -= 1;
    if (col < 0 || this.cellAt(row, col).ch === ' ') return;
    this.setCell(row, col, { ...this.cellAt(row, col), ch: this.cellAt(row, col).ch + ch });
    this.markRow(this.cursorRow);
  }

  private clearCell(row: Row, col: number): void {
    if (col < 0 || col >= this.cols) return;
    if (this.cellAt(row, col).ch === '') {
      this.setCell(row, col, blankCell());
      if (col > 0) this.setCell(row, col - 1, blankCell());
      return;
    }
    if (wcwidth(this.cellAt(row, col).ch) === 2 && col + 1 < this.cols && this.cellAt(row, col + 1).ch === '') {
      this.setCell(row, col + 1, blankCell());
    }
    this.setCell(row, col, blankCell());
  }

  private normalizeRow(row: Row): void {
    for (let col = 0; col < this.cols; col++) {
      if (this.cellAt(row, col).ch === '') {
        if (col === 0 || wcwidth(this.cellAt(row, col - 1).ch) !== 2) this.setCell(row, col, blankCell());
      } else if (wcwidth(this.cellAt(row, col).ch) === 2) {
        if (col === this.cols - 1 || this.cellAt(row, col + 1).ch !== '') this.setCell(row, col, blankCell());
      }
    }
  }

  private wrapToNextLine(): void {
    this.pendingWrap = false;
    this.cursorCol = 0;
    this.lineFeed();
  }

  carriageReturn(): void {
    this.clearPendingWrap();
    // Cursor stays on the same row; mark that row so the cursor span is
    // removed from its old column on rebuild.
    this.markRow(this.cursorRow);
    this.cursorCol = 0;
  }

  lineFeed(): void {
    this.clearPendingWrap();
    if (this.cursorRow === this.scrollBottom && !this.regionIsFullScreen) {
      this.scrollRegionUp(this.scrollTop, this.scrollBottom, 1);
      return;
    }
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
      const gone = this.rowsData.shift();
      this.rowsData.push(this.freshRow(gone));
      // New bottom row's absolute index is the one the cursor is on now.
      this.dirtyRows.copyWithin(0, 1);
      this.dirtyRows[this.rows - 1] = 0;
      if (this.dirtyLines.size > this.rows * 2) this.pruneDirty();
      this.markRow(this.cursorRow);
    }
    this.dirty = true;
  }

  backspace(): void {
    this.clearPendingWrap();
    if (this.cursorCol >= this.cols) this.cursorCol = this.cols - 1;
    if (this.cursorCol > 0) {
      this.cursorCol -= 1;
      this.markRow(this.cursorRow);
    }
  }

  tab(): void {
    this.clearPendingWrap();
    if (this.cursorCol >= this.cols) this.cursorCol = this.cols - 1;
    const next = (Math.floor(this.cursorCol / 8) + 1) * 8;
    this.cursorCol = Math.min(this.cols - 1, next);
    this.markRow(this.cursorRow);
  }

  cursorUp(n: number): void {
    this.setCursorForced(this.cursorRow - Math.max(1, n), this.cursorCol);
  }
  cursorDown(n: number): void {
    this.setCursorForced(this.cursorRow + Math.max(1, n), this.cursorCol);
  }
  cursorForward(n: number): void {
    this.setCursorForced(this.cursorRow, this.cursorCol + Math.max(1, n));
  }
  cursorBack(n: number): void {
    this.setCursorForced(this.cursorRow, this.cursorCol - Math.max(1, n));
  }

  eraseInDisplay(mode: number): void {
    this.clearPendingWrap();
    // 0: cursor to end; 1: start to cursor; 2/3: entire screen
    if (mode === 2 || mode === 3) {
      for (let r = 0; r < this.rows; r++) this.rowsData[r] = makeRow(this.cols);
      this.markRange(0, this.rows - 1);
    } else if (mode === 1) {
      for (let r = 0; r < this.cursorRow; r++) this.rowsData[r] = makeRow(this.cols);
      const row = this.rowsData[this.cursorRow]!;
      for (let c = 0; c <= this.cursorCol && c < this.cols; c++) this.clearCell(row, c);
      this.markRange(0, this.cursorRow);
    } else {
      const row = this.rowsData[this.cursorRow]!;
      for (let c = this.cursorCol; c < this.cols; c++) this.clearCell(row, c);
      for (let r = this.cursorRow + 1; r < this.rows; r++) this.rowsData[r] = makeRow(this.cols);
      this.markRange(this.cursorRow, this.rows - 1);
    }
  }

  eraseInLine(mode: number): void {
    this.clearPendingWrap();
    const row = this.rowsData[this.cursorRow]!;
    if (mode === 1) {
      for (let c = 0; c <= this.cursorCol && c < this.cols; c++) this.clearCell(row, c);
    } else if (mode === 2) {
      for (let c = 0; c < this.cols; c++) this.clearCell(row, c);
    } else {
      for (let c = this.cursorCol; c < this.cols; c++) this.clearCell(row, c);
    }
    this.markRow(this.cursorRow);
  }

  scrollUp(n: number): void {
    n = Math.max(1, n);
    if (!this.regionIsFullScreen) {
      this.scrollRegionUp(this.scrollTop, this.scrollBottom, n);
      return;
    }
    for (let i = 0; i < n; i++) {
      const gone = this.rowsData.shift();
      this.rowsData.push(this.freshRow(gone));
    }
    // All visible rows' content shifted but absolute indexes are stable;
    // content at each visible absolute index changed, so mark them all.
    this.markRange(0, this.rows - 1);
  }
  scrollDown(n: number): void {
    n = Math.max(1, n);
    if (!this.regionIsFullScreen) {
      this.scrollRegionDown(this.scrollTop, this.scrollBottom, n);
      return;
    }
    for (let i = 0; i < n; i++) {
      this.rowsData.pop();
      this.rowsData.unshift(makeRow(this.cols));
    }
    this.markRange(0, this.rows - 1);
  }

  totalLines(): number {
    return this.scrollback.length + this.rows;
  }

  getLine(index: number): Cell[] {
    const relative = index - this.trimmed;
    if (relative >= 0 && relative < this.scrollback.length) return this.cells(this.scrollback.get(relative)!);
    const r = this.rowsData[relative - this.scrollback.length];
    return r ? this.cells(r) : this.cells(makeRow(this.cols));
  }

  clearScrollback(): void {
    this.trimmed += this.scrollback.length;
    this.scrollback.clear();
    this.markAllVisible();
  }

  serialize(): string {
    const sourceScreen = this.inAltScreen ? this.mainScreen : this.rowsData;
    const sourceScrollback = this.inAltScreen ? this.mainScrollback! : this.scrollback;
    const sourceTrimmed = this.inAltScreen ? this.mainTrimmed : this.trimmed;
    const attrs: CellAttr[] = [];
    const indexes = new Map<string, number>();
    const line = (cells: Row): SerializedLine => {
      const runs: SerializedLine = [];
      let text = '';
      let index = -1;
      for (const cell of this.cells(cells)) {
        const key = JSON.stringify(cell.attr);
        let next = indexes.get(key);
        if (next === undefined) {
          next = attrs.length;
          indexes.set(key, next);
          attrs.push({ ...cell.attr });
        }
        if (next !== index && text) runs.push([text, index]);
        if (next !== index) { text = ''; index = next; }
        text += cell.ch === '' ? '\u0000' : cell.ch;
      }
      if (text) runs.push([text, index]);
      const tail = runs[runs.length - 1];
      if (tail && JSON.stringify(attrs[tail[1]]) === JSON.stringify(DEFAULT_ATTR)) {
        const trimmed = tail[0].replace(/ +$/, '');
        if (trimmed) tail[0] = trimmed;
        else runs.pop();
      }
      return runs;
    };
    const lines: SerializedLine[] = [];
    const lineIndexes = new Map<string, number>();
    const encodeLine = (cells: Row): number => {
      const runs = line(cells);
      const key = JSON.stringify(runs);
      let index = lineIndexes.get(key);
      if (index === undefined) {
        index = lines.length;
        lineIndexes.set(key, index);
        lines.push(runs);
      }
      return index;
    };
    const scrollback: number[] = [];
    for (let i = 0; i < sourceScrollback.length; i++) scrollback.push(encodeLine(sourceScrollback.get(i)!));
    return JSON.stringify({ v: 1, cols: this.cols, rows: this.rows, cursor: [this.cursorRow, this.cursorCol], modes: { applicationCursor: this.applicationCursorMode, bracketedPaste: this.bracketedPasteMode, autowrap: this.autoWrapMode, mouseTracking: this.mouseTracking, mouseSgr: this.mouseSgr }, scrollback, screen: sourceScreen.map(encodeLine), lines, attrs, trimmed: sourceTrimmed, ...(this.inAltScreen ? { alt: true } : {}) } satisfies SerializedSnapshot);
  }

  restore(data: string): void {
    let snapshot: SerializedSnapshot;
    try { snapshot = JSON.parse(data) as SerializedSnapshot; } catch { throw new Error('Invalid terminal snapshot'); }
    const validAttr = (attr: unknown): attr is CellAttr => {
      if (!attr || typeof attr !== 'object') return false;
      const value = attr as Record<string, unknown>;
      return Number.isInteger(value.fg) && Number.isInteger(value.bg) && typeof value.bold === 'boolean' && typeof value.italic === 'boolean' && typeof value.underline === 'boolean' && typeof value.reverse === 'boolean' && (value.link === undefined || typeof value.link === 'string');
    };
    const validMouseTracking = (value: unknown): value is 0 | 9 | 1000 | 1002 | 1003 => value === 0 || value === 9 || value === 1000 || value === 1002 || value === 1003;
    if (!snapshot || snapshot.v !== 1 || !Number.isInteger(snapshot.cols) || snapshot.cols < 1 || !Number.isInteger(snapshot.rows) || snapshot.rows < 1 || !Array.isArray(snapshot.cursor) || snapshot.cursor.length !== 2 || !snapshot.cursor.every(Number.isInteger) || !snapshot.modes || typeof snapshot.modes !== 'object' || typeof snapshot.modes.applicationCursor !== 'boolean' || typeof snapshot.modes.bracketedPaste !== 'boolean' || typeof snapshot.modes.autowrap !== 'boolean' || !validMouseTracking(snapshot.modes.mouseTracking) || typeof snapshot.modes.mouseSgr !== 'boolean' || !Array.isArray(snapshot.attrs) || !snapshot.attrs.every(validAttr) || !Array.isArray(snapshot.lines) || !Array.isArray(snapshot.scrollback) || !snapshot.scrollback.every(Number.isInteger) || !Array.isArray(snapshot.screen) || !snapshot.screen.every(Number.isInteger) || !Number.isInteger(snapshot.trimmed) || snapshot.trimmed < 0) throw new Error('Invalid terminal snapshot');
    const sharedAttrs = snapshot.attrs.map((attr) => JSON.stringify(attr) === JSON.stringify(DEFAULT_ATTR) ? DEFAULT_ATTR : Object.freeze({ ...attr }));
    const decode = (runs: SerializedLine): Row => {
      if (!Array.isArray(runs)) throw new Error('Invalid terminal snapshot');
      const cells: Cell[] = [];
      for (const run of runs) {
        if (!Array.isArray(run) || run.length !== 2 || typeof run[0] !== 'string' || !Number.isInteger(run[1]) || !sharedAttrs[run[1]]) throw new Error('Invalid terminal snapshot');
        const attr = sharedAttrs[run[1]]!;
        for (const ch of run[0]) cells.push(ch === '\u0000' ? { ch: '', attr } : internCell(ch, attr));
      }
      if (cells.length > snapshot.cols) throw new Error('Invalid terminal snapshot');
      while (cells.length < snapshot.cols) cells.push(BLANK);
      return this.rowFrom(cells);
    };
    const lines = snapshot.lines.map(decode);
    const resolveLine = (index: number): Row => {
      const line = lines[index];
      if (!line) throw new Error('Invalid terminal snapshot');
      return line;
    };
    const scrollbackLines = snapshot.scrollback.map(resolveLine);
    const screenLines = snapshot.screen.map(resolveLine);
    if (screenLines.length !== snapshot.rows) throw new Error('Invalid terminal snapshot');
    const fit = (row: Row): Row => { const cells = this.cells(row).slice(0, this.cols); while (cells.length < this.cols) cells.push(BLANK); return this.rowFrom(cells); };
    const screen = screenLines.map(fit);
    while (screen.length > this.rows) scrollbackLines.push(screen.shift()!);
    while (screen.length < this.rows) screen.push(makeRow(this.cols));
    const scrollback = new RingBuffer<Row>(this.maxScrollback);
    const start = Math.max(0, scrollbackLines.length - this.maxScrollback);
    for (let i = start; i < scrollbackLines.length; i++) scrollback.push(fit(scrollbackLines[i]!));
    this.inAltScreen = false;
    this.rowsData = screen;
    this.scrollback = scrollback;
    this.trimmed = Math.max(0, snapshot.trimmed + start);
    this.cursorRow = Math.max(0, Math.min(this.rows - 1, snapshot.cursor[0]));
    this.cursorCol = Math.max(0, Math.min(this.cols - 1, snapshot.cursor[1]));
    this.applicationCursorMode = !!snapshot.modes.applicationCursor;
    this.bracketedPasteMode = !!snapshot.modes.bracketedPaste;
    this.autoWrapMode = !!snapshot.modes.autowrap;
    this.mouseTracking = [0, 9, 1000, 1002, 1003].includes(snapshot.modes.mouseTracking) ? snapshot.modes.mouseTracking : 0;
    this.mouseSgr = !!snapshot.modes.mouseSgr;
    this.mainScreen = [];
    this.mainScrollback = null;
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
    this.clearPendingWrap();
    if (this.inAltScreen) {
      if (clear) this.blankBuffer(this.rowsData);
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
    this.mainScreen = this.rowsData;
    this.mainScrollback = this.scrollback;
    this.mainTrimmed = this.trimmed;
    this.rowsData = this.altScreen;
    this.scrollback = new RingBuffer<Row>(this.maxScrollback);
    this.trimmed = 0;
    this.inAltScreen = true;
    if (clear) this.blankBuffer(this.rowsData);
    this.markAllVisible();
  }

  exitAltScreen(clear: boolean, restore: boolean): void {
    this.clearPendingWrap();
    if (!this.inAltScreen) {
      if (restore) {
        this.withCursorMove(() => {
          this.cursorRow = Math.min(this.rows - 1, Math.max(0, this.altReturnRow));
          this.cursorCol = Math.min(this.cols - 1, Math.max(0, this.altReturnCol));
        });
      }
      return;
    }
    if (clear) this.blankBuffer(this.rowsData);
    // Swap back.
    this.altScreen = this.rowsData;
    this.rowsData = this.mainScreen;
    this.scrollback = this.mainScrollback!;
    this.trimmed = this.mainTrimmed;
    this.mainScreen = [];
    this.mainScrollback = null;
    this.mainTrimmed = 0;
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

  private blankBuffer(buf: Row[]): void {
    for (let r = 0; r < buf.length; r++) buf[r] = makeRow(this.cols);
  }

  // DECCKM setter. No dirty flag: input-only, renderer doesn't care.
  setApplicationCursorMode(enabled: boolean): void {
    this.applicationCursorMode = enabled;
  }

  setCursorVisible(enabled: boolean): void {
    if (this.cursorVisible === enabled) return;
    this.cursorVisible = enabled;
    this.markRow(this.cursorRow);
  }

  setAutoWrap(enabled: boolean): void {
    this.autoWrapMode = enabled;
    this.clearPendingWrap();
  }

  // Bracketed paste setter. No dirty flag: input-only, renderer doesn't care.
  setBracketedPaste(enabled: boolean): void {
    this.bracketedPasteMode = enabled;
  }

  setMouseTracking(mode: 0 | 9 | 1000 | 1002 | 1003): void {
    this.mouseTracking = mode;
  }

  setMouseSgr(enabled: boolean): void {
    this.mouseSgr = enabled;
  }
}
