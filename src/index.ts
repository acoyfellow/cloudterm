// cloudterm. Web terminal emulator. DOM-rendered. Built on @chenglou/pretext.

import { AnsiParser, type CellAttr, defaultAttr } from './parser.js';
import type { ParserSink } from './parser.js';
import { Grid } from './grid.js';
import { DomRenderer, defaultTheme, type Theme } from './renderer.js';
import { InputHandler } from './input.js';

export type { Theme } from './renderer.js';

export interface MountOptions {
  onData: (data: Uint8Array) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitle?: (title: string) => void;
  theme?: Partial<Theme>;
  maxScrollback?: number;
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

  // Parser wired to grid.
  let currentAttr: CellAttr = defaultAttr();
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
      /* noop */
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
    },
    setApplicationCursorMode(enabled) {
      grid.setApplicationCursorMode(enabled);
    },
  };

  const parser = new AnsiParser(sink);

  const input = new InputHandler(renderer.root, {
    onData: opts.onData,
    getApplicationCursorMode: () => grid.applicationCursorMode,
  });

  // Schedule paints using rAF to batch bursts of writes.
  let rafPending = false;
  const schedulePaint = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (grid.dirty) renderer.paint();
    });
  };

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
      schedulePaint();
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
.cloudterm-cursor{position:absolute;background:var(--ct-cursor,#7cc4ff);opacity:.4;mix-blend-mode:difference}
.cloudterm-input{position:absolute;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;margin:0;resize:none;white-space:pre;overflow:hidden;z-index:0;background:transparent;color:transparent;caret-color:transparent;outline:none}
.cloudterm:focus-within .cloudterm-cursor{opacity:1}
`;
