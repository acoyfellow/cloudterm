// Headless entry point. Grid + Parser wired together without DOM, renderer,
// input handling, ResizeObserver, fonts, rAF. Feed bytes in, inspect grid
// state directly. Intended for tests, diagnostics, server-side rendering.
//
// This is the single documented way to drive cloudterm outside a browser. If
// you find yourself importing grid.ts or parser.ts from a non-browser
// consumer, reach for createHeadless() instead.
//
// The sink mirrors the one in src/index.ts. Keep in sync if you add parser
// callbacks.

import { AnsiParser, defaultAttr, type CellAttr, type ParserSink } from './parser.js';
import { Grid } from './grid.js';

export { Grid } from './grid.js';
export { AnsiParser, defaultAttr } from './parser.js';
export type { CellAttr, ParserSink } from './parser.js';
export type { Cell, GridSnapshot } from './grid.js';

export interface Headless {
  grid: Grid;
  parser: AnsiParser;
  /** Current SGR attr tracked by the sink. Useful for tests that want to
   *  assert color/bold state without reaching into parser internals. */
  getAttr(): CellAttr;
  /** Feed raw bytes (as emitted by a PTY). UTF-8 partials are buffered. */
  feed(bytes: Uint8Array): void;
  /** Feed a JS string. Convenience for tests that synthesize escape sequences. */
  feedString(text: string): void;
  /** Resize both dimensions. */
  resize(cols: number, rows: number): void;
  /** Collected OSC titles, in arrival order. */
  titles: string[];
  /** Bell count. */
  bells: number;
}

export interface CreateHeadlessOptions {
  maxScrollback?: number;
}

export function createHeadless(
  cols: number,
  rows: number,
  opts: CreateHeadlessOptions = {},
): Headless {
  const grid = new Grid(cols, rows, opts.maxScrollback ?? 10_000);
  let currentAttr: CellAttr = defaultAttr();
  const titles: string[] = [];
  let bells = 0;

  const sink: ParserSink = {
    print(ch) {
      grid.writeChar(ch, currentAttr);
    },
    lineFeed() {
      grid.lineFeed();
    },
    carriageReturn() {
      grid.carriageReturn();
    },
    backspace() {
      grid.backspace();
    },
    tab() {
      grid.tab();
    },
    bell() {
      bells += 1;
    },
    cursorUp(n) {
      grid.cursorUp(n);
    },
    cursorDown(n) {
      grid.cursorDown(n);
    },
    cursorForward(n) {
      grid.cursorForward(n);
    },
    cursorBack(n) {
      grid.cursorBack(n);
    },
    cursorNextLine(n) {
      grid.cursorDown(n);
      grid.carriageReturn();
    },
    cursorPrevLine(n) {
      grid.cursorUp(n);
      grid.carriageReturn();
    },
    cursorColumn(col) {
      grid.setCursor(grid.cursorRow, col - 1);
    },
    cursorPosition(row, col) {
      grid.setCursor(row - 1, col - 1);
    },
    eraseInDisplay(mode) {
      grid.eraseInDisplay(mode);
    },
    eraseInLine(mode) {
      grid.eraseInLine(mode);
    },
    scrollUp(n) {
      grid.scrollUp(n);
    },
    scrollDown(n) {
      grid.scrollDown(n);
    },
    saveCursor() {
      grid.saveCursor();
    },
    restoreCursor() {
      grid.restoreCursor();
    },
    setAttr(a) {
      currentAttr = a;
    },
    title(t) {
      titles.push(t);
    },
    setAltScreen(enabled, o) {
      if (!o.swap) {
        if (enabled && o.save) grid.saveCursorAlt();
        if (!enabled && o.restore) grid.restoreCursorAlt();
        return;
      }
      if (enabled) {
        grid.enterAltScreen(o.save, o.clear);
      } else {
        grid.exitAltScreen(o.clear, o.restore);
      }
    },
    setApplicationCursorMode(enabled) {
      grid.setApplicationCursorMode(enabled);
    },
  };

  const parser = new AnsiParser(sink);

  return {
    grid,
    parser,
    getAttr() {
      return { ...currentAttr };
    },
    feed(bytes) {
      parser.writeBytes(bytes);
    },
    feedString(text) {
      parser.writeString(text);
    },
    resize(c, r) {
      grid.resize(c, r);
    },
    titles,
    get bells() {
      return bells;
    },
  };
}
