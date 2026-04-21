// cloudterm. Web terminal emulator. DOM-rendered. Built on @chenglou/pretext.

import { AnsiParser, type CellAttr, defaultAttr } from './parser.js';
import type { ParserSink } from './parser.js';
import { Grid } from './grid.js';
import { DomRenderer, defaultTheme, type Theme } from './renderer.js';
import { InputHandler } from './input.js';
import { PredictionBuffer } from './predict.js';

export type { Theme } from './renderer.js';

export interface MountOptions {
  onData: (data: Uint8Array) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitle?: (title: string) => void;
  // Fires when the shell reports a new working directory via OSC 7. The URI
  // is a `file://` URL (e.g. `file://host/home/user`). No-op if unset.
  onCwd?: (uri: string) => void;
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
  await nextFrame();
  const docAny = document as unknown as { fonts?: { ready?: Promise<unknown> } };
  if (docAny.fonts?.ready) {
    try {
      await docAny.fonts.ready;
    } catch {
      /* noop */
    }
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
  const sink: ParserSink = {
    print(ch) {
      if (predictions) {
        reconcilePrint(ch);
      } else {
        grid.writeChar(ch, currentAttr);
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
    setBracketedPaste(enabled) {
      grid.setBracketedPaste(enabled);
    },
    setCurrentDirectory(uri) {
      if (opts.onCwd) opts.onCwd(uri);
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

  // Auto-focus on mount so users can type immediately.
  input.focus();

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
    destroy() {
      destroyed = true;
      if (predictSweepTimer !== null) {
        clearTimeout(predictSweepTimer);
        predictSweepTimer = null;
      }
      ro.disconnect();
      el.removeEventListener('mouseup', onMouseUp);
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

// KEEP IN SYNC with src/style.css.
const BASE_CSS = `
.cloudterm{position:relative;width:100%;height:100%;background:var(--ct-bg,#0b0c10);color:var(--ct-fg,#e6e8eb);font-family:var(--ct-font,ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace);font-size:var(--ct-font-size,13px);line-height:1.4;overflow:hidden;cursor:text}
.cloudterm-viewport{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;contain:strict}
.cloudterm-sizer{position:relative;width:1px}
.cloudterm-surface{position:absolute;top:0;left:0;right:0}
.cloudterm-line{position:absolute;left:0;right:0;white-space:pre;contain:content}
.cloudterm-line span{white-space:pre}
.cloudterm-cursor{position:absolute;background:var(--ct-cursor,#7cc4ff);opacity:.4;mix-blend-mode:difference;pointer-events:none;z-index:1}
.cloudterm-predictions{position:absolute;top:0;left:0;right:0;pointer-events:none}
.cloudterm-predict{position:absolute;pointer-events:none;font:inherit;color:var(--ct-fg,#e6e8eb);opacity:.85;white-space:pre}
.cloudterm-input{position:absolute;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;margin:0;resize:none;white-space:pre;overflow:hidden;z-index:0;background:transparent;color:transparent;caret-color:transparent;outline:none}
.cloudterm:focus-within .cloudterm-cursor{opacity:1}
`;
