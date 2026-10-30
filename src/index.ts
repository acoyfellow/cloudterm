// cloudterm. Web terminal emulator. DOM-rendered. Built on @chenglou/pretext.

import { AnsiParser, type CellAttr, defaultAttr } from './parser.js';
import type { ParserSink } from './parser.js';
import { Grid } from './grid.js';
import { DomRenderer, defaultTheme, type Theme } from './renderer.js';
import { InputHandler } from './input.js';
import { encodeMouse, mapMouseCoordinates } from './mouse.js';
import { PredictionBuffer } from './predict.js';
import { wcwidth } from './wcwidth.js';
import { BASE_CSS } from './base-css.js';
import { searchGrid, type SearchMatch, type SearchOptions } from './search.js';

export type { SearchMatch, SearchOptions } from './search.js';

export type { Theme } from './renderer.js';

export interface MountOptions {
  onData: (data: Uint8Array) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitle?: (title: string) => void;
  // Fires when the shell reports a new working directory via OSC 7. The URI
  // is a `file://` URL (e.g. `file://host/home/user`). No-op if unset.
  onCwd?: (uri: string) => void;
  onClipboard?: (text: string, selection: string) => void;
  theme?: Partial<Theme>;
  maxScrollback?: number;
  // Speculative local echo. 'auto' (default) paints predicted characters as
  // an overlay and reconciles them against incoming grid mutations. 'off'
  // disables the whole system: no overlay, no callback fires. There is no
  // RTT-aware middle mode; Mosh does that and we skip it.
  predictionMode?: 'off' | 'auto';
}

export interface Terminal {
  write(data: string | Uint8Array): void;
  fit(): void;
  focus(): void;
  destroy(): void;
  search(query: string, opts?: SearchOptions): SearchMatch[];
  findNext(query: string, opts?: SearchOptions): SearchMatch | null;
  findPrevious(query: string, opts?: SearchOptions): SearchMatch | null;
  clearSearch(): void;
  serialize(): string;
  restore(data: string): void;
  readonly cols: number;
  readonly rows: number;
}

export async function mount(el: HTMLElement, opts: MountOptions): Promise<Terminal> {
  const theme: Theme = { ...defaultTheme, ...(opts.theme ?? {}) };

  // Create with placeholder size. We measure post-DOM-attach.
  const grid = new Grid(80, 24, opts.maxScrollback ?? 10_000);

  // Inject minimal inline fallback styles if stylesheet absent (consumers may
  // import the css file themselves; we don't force it).
  ensureBaseStyles();

  const renderer = new DomRenderer(el, grid, theme);

  // Wait a frame so fonts settle and viewport has size.
  const fonts = (document as unknown as { fonts?: { ready: Promise<unknown>; status: string } }).fonts;
  if (!el.clientHeight || fonts?.status !== 'loaded') {
    await nextFrame();
    await fonts?.ready.catch(() => undefined);
  }
  renderer.measure();
  renderer.fit();

  // Speculative local-echo buffer. Reconciled against grid mutations in the
  // sink wrapper below. Renderer paints it as an overlay every frame.
  const predictionMode = opts.predictionMode ?? 'auto';
  const predictionEnabled = predictionMode !== 'off';
  const predictions = predictionEnabled ? new PredictionBuffer() : null;
  if (predictions) renderer.predictions = predictions;

  // Reconciliation hooks wrapping grid-mutating sink calls. Keep Grid pure;
  // reconcile at the sink layer. writeChar implicitly advances the cursor,
  // so reconcilePrint also consumes any cursor prediction matching the
  // post-write position.
  const reconcilePrint = (ch: string): void => {
    if (!predictions) return;
    const r = grid.cursorRow;
    const c = grid.cursorCol;
    grid.writeChar(ch, currentAttr);
    predictions.onGridPrint(r, c, ch);
    predictions.onGridCursor(grid.cursorRow, grid.cursorCol);
  };
  const reconcileCursor = (): void => {
    if (!predictions) return;
    predictions.onGridCursor(grid.cursorRow, grid.cursorCol);
  };

  // Parser wired to grid.
  let currentAttr: CellAttr = defaultAttr();
  let lastPrinted = ' ';
  const sink: ParserSink = {
    print(ch) {
      lastPrinted = ch;
      if (predictions) {
        reconcilePrint(ch);
      } else {
        grid.writeChar(ch, currentAttr);
      }
    },
    printRun(text) {
      lastPrinted = text[text.length - 1]!;
      if (predictions?.size) {
        for (const ch of text) reconcilePrint(ch);
      } else {
        grid.writeAscii(text, currentAttr);
      }
    },
    printRunRange(text, start, end) {
      lastPrinted = text[end - 1]!;
      if (predictions?.size) {
        for (let i = start; i < end; i++) reconcilePrint(text[i]!);
      } else {
        grid.writeAscii(text, currentAttr, start, end);
      }
    },
    lineFeed() {
      grid.lineFeed();
      reconcileCursor();
    },
    carriageReturn() {
      grid.carriageReturn();
      reconcileCursor();
    },
    backspace() {
      grid.backspace();
      reconcileCursor();
    },
    tab() {
      grid.tab();
      reconcileCursor();
    },
    bell() {
      /* noop */
    },
    cursorUp(n) {
      grid.cursorUp(n);
      reconcileCursor();
    },
    cursorDown(n) {
      grid.cursorDown(n);
      reconcileCursor();
    },
    cursorForward(n) {
      grid.cursorForward(n);
      reconcileCursor();
    },
    cursorBack(n) {
      grid.cursorBack(n);
      reconcileCursor();
    },
    cursorNextLine(n) {
      grid.cursorDown(n);
      grid.carriageReturn();
      reconcileCursor();
    },
    cursorPrevLine(n) {
      grid.cursorUp(n);
      grid.carriageReturn();
      reconcileCursor();
    },
    cursorColumn(col) {
      grid.setCursor(grid.cursorRow, col - 1);
      reconcileCursor();
    },
    cursorPosition(row, col) {
      grid.setCursor(row - 1, col - 1);
      reconcileCursor();
    },
    eraseInDisplay(mode) {
      grid.eraseInDisplay(mode);
      // Any large-area erase invalidates our speculative overlay: the server
      // is clearly doing something we did not predict (clear-screen, redraw).
      if (predictions) predictions.clear();
    },
    eraseInLine(mode) {
      grid.eraseInLine(mode);
      if (predictions) predictions.clear();
    },
    scrollUp(n) {
      grid.scrollUp(n);
      if (predictions) predictions.clear();
    },
    scrollDown(n) {
      grid.scrollDown(n);
      if (predictions) predictions.clear();
    },
    setScrollRegion(top, bottom) {
      grid.setScrollRegion(top - 1, bottom === 0 ? grid.rows - 1 : bottom - 1);
      if (predictions) predictions.clear();
    },
    cursorRow(row) {
      grid.cursorRowAbsolute(row - 1);
      reconcileCursor();
    },
    insertLines(n) {
      grid.insertLines(n);
      if (predictions) predictions.clear();
    },
    deleteLines(n) {
      grid.deleteLines(n);
      if (predictions) predictions.clear();
    },
    insertChars(n) {
      grid.insertChars(n);
      if (predictions) predictions.clear();
    },
    deleteChars(n) {
      grid.deleteChars(n);
      if (predictions) predictions.clear();
    },
    eraseChars(n) {
      grid.eraseChars(n);
      if (predictions) predictions.clear();
    },
    reverseIndex() {
      grid.reverseIndex();
      if (predictions) predictions.clear();
    },
    repeatLast(n) {
      for (let i = 0; i < Math.min(n, grid.cols * grid.rows); i++) {
        if (predictions) reconcilePrint(lastPrinted);
        else grid.writeChar(lastPrinted, currentAttr);
      }
    },
    saveCursor() {
      grid.saveCursor();
    },
    restoreCursor() {
      grid.restoreCursor();
      reconcileCursor();
    },
    setAttr(a) {
      currentAttr = a;
    },
    title(t) {
      if (opts.onTitle) opts.onTitle(t);
    },
    setAltScreen(enabled, o) {
      if (!o.swap) {
        // 1048 path: cursor save/restore without a buffer swap.
        if (enabled && o.save) grid.saveCursorAlt();
        if (!enabled && o.restore) grid.restoreCursorAlt();
        return;
      }
      if (enabled) {
        grid.enterAltScreen(o.save, o.clear);
      } else {
        grid.exitAltScreen(o.clear, o.restore);
      }
      // Alt-screen transitions mean the screen we were predicting against is
      // no longer in front of the user.
      if (predictions) predictions.clear();
    },
    setApplicationCursorMode(enabled) {
      grid.setApplicationCursorMode(enabled);
      // Apps that use DECCKM (vim, less) do not local-echo typed keys.
      if (predictions) predictions.clear();
    },
    setCursorVisible(enabled) {
      grid.setCursorVisible(enabled);
    },
    setAutoWrap(enabled) {
      grid.setAutoWrap(enabled);
      if (predictions) predictions.clear();
    },
    setBracketedPaste(enabled) {
      grid.setBracketedPaste(enabled);
    },
    setMouseTracking(mode) {
      grid.setMouseTracking(mode);
    },
    setMouseSgr(enabled) {
      grid.setMouseSgr(enabled);
    },
    setCurrentDirectory(uri) {
      if (opts.onCwd) opts.onCwd(uri);
    },
    clipboard(text, selection) {
      opts.onClipboard?.(text, selection);
    },
  };

  const parser = new AnsiParser(sink);

  // Speculation always fires when enabled. Originally this gate suppressed
  // prediction in alt-screen or DECCKM on the theory that full-screen TUIs
  // do not local-echo typed keys. That theory is wrong for the common case
  // where the outer shell itself runs inside tmux (cloudshell does): tmux
  // sets alt-screen for its own lifetime, so suppression meant prediction
  // never fired at the interactive prompt. Reconciliation already handles
  // the "server did not echo what I predicted" case by dropping the whole
  // queue on mismatch, so the worst an over-aggressive prediction does is
  // flash a glyph that gets overwritten within the existing render window.
  const predictionAllowed = (): boolean => predictions !== null;

  // When the user types with nothing to reconcile against (e.g. a password
  // prompt where the shell has `stty -echo`), stale predictions would sit
  // painted until the next server write. Schedule a lazy sweep that prunes
  // and repaints once per TTL window while predictions are outstanding.
  const PREDICT_TTL_MS = 500;
  let predictSweepTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  const schedulePredictSweep = (): void => {
    if (!predictions || predictSweepTimer !== null || destroyed) return;
    predictSweepTimer = setTimeout(() => {
      predictSweepTimer = null;
      if (destroyed) return;
      predictions.prune(performance.now());
      schedulePaint(true);
      if (predictions.size > 0) schedulePredictSweep();
    }, PREDICT_TTL_MS + 16);
  };

  // Effective cursor for speculation: the latest pending cursor prediction
  // if any, else the real grid cursor. Lets successive keystrokes stack
  // (type 'a', type 'b', delete 'b', type 'c' all before any echo).
  const effectiveCursor = (): { row: number; col: number } => {
    if (predictions) {
      let row = grid.cursorRow;
      let col = grid.cursorCol;
      for (const p of predictions.iter()) {
        if (p.kind === 'cursor') {
          row = p.row;
          col = p.col;
        }
      }
      return { row, col };
    }
    return { row: grid.cursorRow, col: grid.cursorCol };
  };

  const input = new InputHandler(renderer.root, {
    onData: opts.onData,
    getApplicationCursorMode: () => grid.applicationCursorMode,
    getBracketedPasteMode: () => grid.bracketedPasteMode,
    predict: predictions
      ? (ev) => {
          if (!predictionAllowed()) return;
          const now = performance.now();
          predictions.prune(now);
          const { row, col } = effectiveCursor();
          if (ev.kind === 'char') {
            if (wcwidth(ev.ch) !== 1) return;
            // Only predict within the current row. At end-of-line the shell
            // may wrap differently; let the server's echo be authoritative.
            if (col >= grid.cols) return;
            predictions.push({ kind: 'print', row, col, ch: ev.ch, at: now });
            predictions.push({
              kind: 'cursor',
              row,
              col: Math.min(grid.cols - 1, col + 1),
              at: now,
            });
            schedulePaint(true);
            schedulePredictSweep();
          } else if (ev.kind === 'backspace') {
            if (col <= 0) return; // at BOL: shell may or may not move us.
            predictions.push({
              kind: 'cursor',
              row,
              col: col - 1,
              at: now,
            });
            predictions.push({
              kind: 'print',
              row,
              col: col - 1,
              ch: ' ',
              at: now,
            });
            schedulePaint(true);
            schedulePredictSweep();
          }
        }
      : undefined,
  });

  // Schedule paints using rAF to batch bursts of writes. `force` bypasses the
  // grid.dirty gate: prediction overlay changes need a paint even though the
  // authoritative grid did not mutate.
  let rafPending = false;
  let rafForce = false;
  function schedulePaint(force = false): void {
    if (force) rafForce = true;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const mustPaint = grid.dirty || rafForce;
      rafForce = false;
      if (mustPaint) renderer.paint();
    });
  }

  // Resize handling.
  const ro = new ResizeObserver(() => {
    if (renderer.fit()) {
      if (opts.onResize) opts.onResize(grid.cols, grid.rows);
    }
    renderer.paint();
  });
  ro.observe(el);

  // Initial paint.
  renderer.paint();
  // Fire initial resize so consumer sizes PTY on connect.
  if (opts.onResize) opts.onResize(grid.cols, grid.rows);

  // Focus management. Click anywhere in the host refocuses the textarea so
  // typing lands in the terminal. We skip refocus when the user has an active
  // text selection (so copy works), and we use mouseup so native selection
  // completes first.
  const onMouseUp = () => {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (sel && sel.toString().length > 0) return;
    input.focus();
  };
  el.addEventListener('mouseup', onMouseUp);

  let activeMouseButton: 0 | 1 | 2 | 3 = 3;
  let lastMouseCell: { col: number; row: number } | null = null;
  const mouseCell = (event: MouseEvent | WheelEvent): { col: number; row: number } => {
    const rect = renderer.viewport.getBoundingClientRect();
    const cell = mapMouseCoordinates({
      clientX: event.clientX,
      clientY: event.clientY,
      rect,
      charWidth: renderer.charWidth,
      lineHeight: renderer.lineHeight,
      scrollTop: renderer.viewport.scrollTop,
      screenTop: grid.scrollback.length * renderer.lineHeight,
    });
    return {
      col: Math.max(1, Math.min(grid.cols, cell.col)),
      row: Math.max(1, Math.min(grid.rows, cell.row)),
    };
  };
  const reportMouse = (event: MouseEvent | WheelEvent, kind: 'press' | 'release' | 'move' | 'wheel', button: 0 | 1 | 2 | 3, wheelUp?: boolean): void => {
    if (grid.mouseTracking === 0 || event.shiftKey) return;
    event.preventDefault();
    const cell = mouseCell(event);
    if (kind === 'move' && lastMouseCell?.col === cell.col && lastMouseCell.row === cell.row) return;
    lastMouseCell = cell;
    const data = encodeMouse({
      kind,
      button,
      col: cell.col,
      row: cell.row,
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey,
      wheelUp,
    }, { tracking: grid.mouseTracking, sgr: grid.mouseSgr });
    if (data) opts.onData(new TextEncoder().encode(data));
  };
  const onMouseDown = (event: MouseEvent): void => {
    if (event.button < 0 || event.button > 2) return;
    activeMouseButton = event.button as 0 | 1 | 2;
    reportMouse(event, 'press', activeMouseButton);
  };
  const onMouseMove = (event: MouseEvent): void => {
    const button = event.buttons === 0 ? 3 : activeMouseButton;
    reportMouse(event, 'move', button);
  };
  const onMouseReportUp = (event: MouseEvent): void => {
    if (event.button < 0 || event.button > 2) return;
    reportMouse(event, 'release', event.button as 0 | 1 | 2);
    activeMouseButton = 3;
  };
  const onWheel = (event: WheelEvent): void => {
    reportMouse(event, 'wheel', 3, event.deltaY < 0);
  };
  renderer.viewport.addEventListener('mousedown', onMouseDown);
  renderer.viewport.addEventListener('mousemove', onMouseMove);
  renderer.viewport.addEventListener('mouseup', onMouseReportUp);
  renderer.viewport.addEventListener('wheel', onWheel, { passive: false });
  const onLinkClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('a.cloudterm-link')) return;
    if (grid.mouseTracking !== 0 && !event.ctrlKey && !event.metaKey) event.preventDefault();
  };
  renderer.viewport.addEventListener('click', onLinkClick);

  // Auto-focus on mount so users can type immediately.
  input.focus();

  let searchCursor = -1;
  let searchKey = '';
  const showMatch = (match: SearchMatch | null): SearchMatch | null => {
    renderer.setSearchMatch(match);
    if (match) renderer.scrollToLine(match.line);
    return match;
  };

  const term: Terminal = {
    write(data) {
      if (typeof data === 'string') parser.writeString(data);
      else parser.writeBytes(data);
      // Prune stale predictions once per server write. In-flight keystrokes
      // that never got echoed will fall off within ttlMs (e.g. password
      // prompt where the shell has `stty -echo`).
      if (predictions) predictions.prune(performance.now());
      // Force a paint when predictions are active so the overlay refreshes
      // (a prediction may have been consumed and its ghost needs removal)
      // even if grid had no new dirty lines this batch.
      schedulePaint(predictions !== null && predictions.size > 0);
    },
    fit() {
      if (renderer.fit()) {
        if (opts.onResize) opts.onResize(grid.cols, grid.rows);
      }
      renderer.paint();
    },
    focus() {
      input.focus();
    },
    search(query, options) {
      return searchGrid(grid, query, options);
    },
    findNext(query, options) {
      const matches = searchGrid(grid, query, options);
      const key = JSON.stringify([query, options]);
      searchCursor = key === searchKey ? (searchCursor + 1) % Math.max(1, matches.length) : 0;
      searchKey = key;
      return showMatch(matches[searchCursor] ?? null);
    },
    findPrevious(query, options) {
      const matches = searchGrid(grid, query, options);
      const key = JSON.stringify([query, options]);
      searchCursor = key === searchKey ? (searchCursor - 1 + Math.max(1, matches.length)) % Math.max(1, matches.length) : matches.length - 1;
      searchKey = key;
      return showMatch(matches[searchCursor] ?? null);
    },
    clearSearch() {
      searchCursor = -1;
      searchKey = '';
      showMatch(null);
    },
    serialize() {
      return grid.serialize();
    },
    restore(data) {
      grid.restore(data);
      renderer.paint();
    },
    destroy() {
      destroyed = true;
      if (predictSweepTimer !== null) {
        clearTimeout(predictSweepTimer);
        predictSweepTimer = null;
      }
      ro.disconnect();
      el.removeEventListener('mouseup', onMouseUp);
      renderer.viewport.removeEventListener('mousedown', onMouseDown);
      renderer.viewport.removeEventListener('mousemove', onMouseMove);
      renderer.viewport.removeEventListener('mouseup', onMouseReportUp);
      renderer.viewport.removeEventListener('wheel', onWheel);
      renderer.viewport.removeEventListener('click', onLinkClick);
      input.destroy();
      renderer.destroy();
    },
    get cols() {
      return grid.cols;
    },
    get rows() {
      return grid.rows;
    },
  };

  return term;
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

// Inject a tiny stylesheet if no stylesheet with our tag is present. This keeps
// the demo working even if the consumer forgets to import the CSS file.
function ensureBaseStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('cloudterm-base-styles')) return;
  const s = document.createElement('style');
  s.id = 'cloudterm-base-styles';
  s.textContent = BASE_CSS;
  document.head.appendChild(s);
}
