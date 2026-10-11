// DOM renderer. Pretext-aware measurement. Line virtualization.
//
// Host layout (all inside the mount element):
//   .cloudterm                     position:relative, scrolls via inner viewport
//     .cloudterm-viewport          overflow:auto
//       .cloudterm-sizer           height = totalLines * lineHeight (absolute spacer)
//       .cloudterm-surface         absolute, translated by scrollTop, contains visible line divs
//         .cloudterm-cursor        single long-lived element at surface root
//     textarea.cloudterm-input     offscreen
//
// Each line is a <div class="cloudterm-line"> with absolute top.
// Inside each line, runs of same-styled text are <span>s.
//
// The cursor is a single surface-level <span class="cloudterm-cursor"> that
// never moves out of the DOM. Every paint repositions its top/left/width/
// height. This decouples cursor rendering from line rebuilds: a cursor
// blink or same-line cursor move does not rebuild any line.
//
// Per-line virtualization: only lines whose absolute index lies in the
// viewport (plus overscan) have a div in the DOM. Of those, only lines
// that Grid marked dirty since the last paint are rebuilt. Lines newly
// entering the visible range build regardless (they have no div yet).

import { prepare, layout } from '@chenglou/pretext';
import type { CellAttr } from './parser.js';
import type { Cell } from './grid.js';
import { Grid } from './grid.js';
import { wcwidth } from './wcwidth.js';
import type { PredictionBuffer } from './predict.js';

export interface Theme {
  background: string;
  foreground: string;
  cursor: string;
  fontFamily: string;
  fontSize: number;
}

export const defaultTheme: Theme = {
  background: '#0b0c10',
  foreground: '#e6e8eb',
  cursor: '#7cc4ff',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
};

// ANSI palette (xterm-ish). 16 colors.
const PALETTE_16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

function rgbHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function xterm256Color(n: number): string {
  if (n < 16) return PALETTE_16[n]!;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return rgbHex(v, v, v);
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const map = [0, 95, 135, 175, 215, 255];
  return rgbHex(map[r]!, map[g]!, map[b]!);
}

const PALETTE_256 = Array.from({ length: 256 }, (_, index) => xterm256Color(index));
const truecolorCache = new Map<number, string>();

function colorOf(n: number, fallback: string): string {
  if (n < 0) return fallback;
  if (n & 0x01000000) {
    const cached = truecolorCache.get(n);
    if (cached) return cached;
    const color = rgbHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    if (truecolorCache.size >= 4096) truecolorCache.clear();
    truecolorCache.set(n, color);
    return color;
  }
  if (n < 256) return PALETTE_256[n]!;
  return fallback;
}

// Compare two attrs for run-grouping equality. A shared reference (fast path)
// is a definite equal; otherwise compare fields. Parser hands the same attr
// object for every cell between SGR changes, so identity check wins on
// typical shell output.
function attrEq(a: CellAttr, b: CellAttr): boolean {
  if (a === b) return true;
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.reverse === b.reverse &&
    a.link === b.link
  );
}

function safeLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' || protocol === 'file:' ? value : undefined;
  } catch {
    return undefined;
  }
}

export class DomRenderer {
  host: HTMLElement;
  theme: Theme;
  grid: Grid;

  root: HTMLDivElement;
  viewport: HTMLDivElement;
  sizer: HTMLDivElement;
  surface: HTMLDivElement;
  cursorEl: HTMLSpanElement;
  predictLayer: HTMLDivElement;

  charWidth = 8;
  lineHeight = 16;
  private stickBottom = true;

  // Virtualization: track rendered line indexes -> their divs.
  private rendered = new Map<number, HTMLDivElement>();
  private linePool: HTMLDivElement[] = [];
  private overscan = 4;
  private hadPredictions = false;

  // Optional speculative-echo overlay. When set, paint() rebuilds the overlay
  // layer from this buffer on every frame. Items are small (0-5 typical).
  predictions: PredictionBuffer | null = null;

  constructor(host: HTMLElement, grid: Grid, theme: Theme) {
    this.host = host;
    this.grid = grid;
    this.theme = theme;
    this.root = document.createElement('div');
    this.root.className = 'cloudterm';
    this.viewport = document.createElement('div');
    this.viewport.className = 'cloudterm-viewport';
    this.sizer = document.createElement('div');
    this.sizer.className = 'cloudterm-sizer';
    this.surface = document.createElement('div');
    this.surface.className = 'cloudterm-surface';
    // Single long-lived cursor element. Positioned absolutely at surface
    // root so same-line cursor moves never touch a line div. Styling
    // (color, blend mode) lives in the CSS class.
    this.cursorEl = document.createElement('span');
    this.cursorEl.className = 'cloudterm-cursor';
    // Prediction overlay lives above lines, below cursor's blend layer. Its
    // children are absolute-positioned ghost glyphs rebuilt every paint.
    this.predictLayer = document.createElement('div');
    this.predictLayer.className = 'cloudterm-predictions';
    this.viewport.appendChild(this.sizer);
    this.viewport.appendChild(this.surface);
    this.surface.appendChild(this.predictLayer);
    this.surface.appendChild(this.cursorEl);
    this.root.appendChild(this.viewport);
    this.host.appendChild(this.root);

    this.applyTheme();

    this.viewport.addEventListener('scroll', () => {
      // If user scrolls up, stop sticking to bottom.
      const vp = this.viewport;
      const atBottom =
        vp.scrollTop + vp.clientHeight >= vp.scrollHeight - this.lineHeight;
      this.stickBottom = atBottom;
      this.paint();
    });
  }

  applyTheme(): void {
    const t = this.theme;
    this.root.style.setProperty('--ct-bg', t.background);
    this.root.style.setProperty('--ct-fg', t.foreground);
    this.root.style.setProperty('--ct-cursor', t.cursor);
    this.root.style.setProperty('--ct-font', t.fontFamily);
    this.root.style.setProperty('--ct-font-size', `${t.fontSize}px`);
  }

  measure(): void {
    const font = `${this.theme.fontSize}px ${this.theme.fontFamily}`;
    // Use pretext for line height, canvas for char width (monospace assumption).
    try {
      const prepared = prepare('M', font);
      const r = layout(prepared, 10_000, this.theme.fontSize * 1.4);
      this.lineHeight = Math.max(
        this.theme.fontSize + 2,
        Math.round(r.height || this.theme.fontSize * 1.4),
      );
    } catch {
      this.lineHeight = Math.round(this.theme.fontSize * 1.4);
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = font;
      const w = ctx.measureText('M').width;
      this.charWidth = Math.max(1, w);
    }
  }

  // Compute cols/rows that fit the viewport.
  computeGrid(): { cols: number; rows: number } {
    const rect = this.viewport.getBoundingClientRect();
    const w = rect.width - 2; // small padding guard
    const h = rect.height;
    const cols = Math.max(1, Math.floor(w / this.charWidth));
    const rows = Math.max(1, Math.floor(h / this.lineHeight));
    return { cols, rows };
  }

  fit(): boolean {
    const prev = { cols: this.grid.cols, rows: this.grid.rows };
    const { cols, rows } = this.computeGrid();
    if (cols === prev.cols && rows === prev.rows) return false;
    this.grid.resize(cols, rows);
    return true;
  }

  paint(): void {
    const total = this.grid.totalLines();
    const targetHeight = total * this.lineHeight;
    if (this.sizer.style.height !== `${targetHeight}px`) {
      this.sizer.style.height = `${targetHeight}px`;
    }

    const vp = this.viewport;
    if (this.stickBottom) {
      vp.scrollTop = Math.max(0, vp.scrollHeight - vp.clientHeight);
    }
    const scrollTop = vp.scrollTop;
    const vpHeight = vp.clientHeight || this.grid.rows * this.lineHeight;

    const first = this.grid.trimmed + Math.max(0, Math.floor(scrollTop / this.lineHeight) - this.overscan);
    const last = this.grid.trimmed + Math.min(
      total - 1,
      Math.ceil((scrollTop + vpHeight) / this.lineHeight) + this.overscan,
    );

    // Consume dirty state once per paint. After this call, the grid has no
    // record of what changed; any subsequent mutation will mark itself dirty
    // for the next paint.
    const { dirtyAll, dirtyLines } = this.grid.consumeDirty();

    // Remove stale
    for (const [idx, el] of this.rendered) {
      if (idx < first || idx > last) {
        el.remove();
        this.rendered.delete(idx);
        if (this.linePool.length < this.grid.rows * 2) this.linePool.push(el);
      }
    }

    // Add / update visible. For each visible absolute index:
    //   - if no div exists: build one (newly scrolled into view).
    //   - else if dirtyAll or index in dirtyLines: rebuild contents.
    //   - else: just update top (cheap; the div is already correct).
    for (let i = first; i <= last; i++) {
      const existing = this.rendered.get(i);
      const mustRebuild = dirtyAll || dirtyLines.has(i);
      if (existing) {
        existing.style.top = `${(i - this.grid.trimmed) * this.lineHeight}px`;
        if (mustRebuild) {
          this.renderLineInto(existing, this.grid.getLine(i));
        }
        continue;
      }
      const div = this.linePool.pop() ?? document.createElement('div');
      div.className = 'cloudterm-line';
      div.style.top = `${(i - this.grid.trimmed) * this.lineHeight}px`;
      div.style.height = `${this.lineHeight}px`;
      this.renderLineInto(div, this.grid.getLine(i));
      this.surface.appendChild(div);
      this.rendered.set(i, div);
    }

    // Rebuild prediction overlay before cursor so cursor is above it. The
    // layer is cheap to rebuild: typically 0-5 absolute-positioned spans.
    this.paintPredictions();

    // Position the single surface-level cursor element. Absolute index of
    // the cursor lets us place it relative to the surface without tracking
    // which line div it would belong to. If there is a live cursor
    // prediction, steer the cursor to the predicted position so it tracks
    // typing without waiting for the server.
    this.positionCursor();
  }

  private positionCursor(): void {
    if (!this.grid.cursorVisible) {
      this.cursorEl.style.display = 'none';
      return;
    }
    let row = this.grid.cursorRow;
    let col = this.grid.cursorCol;
    const latest = this.latestCursorPrediction();
    if (latest) {
      row = latest.row;
      col = latest.col;
    }
    const cursorAbs = this.grid.trimmed + this.grid.scrollback.length + row;
    this.cursorEl.style.display = '';
    this.cursorEl.style.top = `${(cursorAbs - this.grid.trimmed) * this.lineHeight}px`;
    this.cursorEl.style.left = `${col * this.charWidth}px`;
    this.cursorEl.style.width = `${this.charWidth}px`;
    this.cursorEl.style.height = `${this.lineHeight}px`;
  }

  private latestCursorPrediction(): { row: number; col: number } | null {
    if (!this.predictions) return null;
    let last: { row: number; col: number } | null = null;
    for (const p of this.predictions.iter()) {
      if (p.kind === 'cursor') last = { row: p.row, col: p.col };
    }
    return last;
  }

  private paintPredictions(): void {
    const predictions = this.predictions;
    const hasPredictions = predictions !== null && predictions.size > 0;
    if (!hasPredictions && !this.hadPredictions) return;
    this.predictLayer.textContent = '';
    this.hadPredictions = hasPredictions;
    if (!predictions || !hasPredictions) return;
    const scrollbackLen = this.grid.scrollback.length;
    for (const p of predictions.iter()) {
      if (p.kind !== 'print') continue;
      // Skip predictions that would land outside the current grid shape
      // (resize could have shrunk us below the prediction column).
      if (p.col < 0 || p.col >= this.grid.cols) continue;
      if (p.row < 0 || p.row >= this.grid.rows) continue;
      // If the authoritative cell already matches the prediction, there is
      // no visual benefit to the overlay (and a risk of subpixel ghosting).
      const line = this.grid.screen[p.row];
      if (line && line[p.col] && line[p.col]!.ch === p.ch) continue;
      const abs = this.grid.trimmed + scrollbackLen + p.row;
      const span = document.createElement('span');
      span.className = 'cloudterm-predict';
      span.style.top = `${(abs - this.grid.trimmed) * this.lineHeight}px`;
      span.style.left = `${p.col * this.charWidth}px`;
      span.style.width = `${this.charWidth}px`;
      span.style.height = `${this.lineHeight}px`;
      span.textContent = p.ch;
      this.predictLayer.appendChild(span);
    }
  }

  private renderLineInto(div: HTMLDivElement, line: Cell[]): void {
    const runs: Array<{ text: string; attr: CellAttr; width: number }> = [];
    let runAttr: CellAttr | null = null;
    let runBuf = '';
    const flush = (): void => {
      if (runAttr && runBuf) runs.push({ text: runBuf, attr: runAttr, width: 1 });
      runAttr = null;
      runBuf = '';
    };
    for (let i = 0; i < line.length; i++) {
      const cell = line[i]!;
      if (cell.ch === '') continue;
      if (wcwidth(cell.ch) === 2 && this.isWideCell(line, i)) {
        flush();
        runs.push({ text: cell.ch, attr: cell.attr, width: 2 });
        continue;
      }
      if (runAttr && attrEq(cell.attr, runAttr)) runBuf += cell.ch;
      else {
        flush();
        runAttr = cell.attr;
        runBuf = cell.ch;
      }
    }
    flush();
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index]!;
      const link = safeLink(run.attr.link);
      const tagName = link ? 'A' : 'SPAN';
      const existing = div.children[index] as HTMLElement | undefined;
      const element = existing?.tagName === tagName ? existing : document.createElement(tagName.toLowerCase());
      if (existing && existing !== element) existing.replaceWith(element);
      this.emitRun(element, run.text, run.attr, run.width, link);
      if (!element.parentElement) div.appendChild(element);
    }
    while (div.children.length > runs.length) div.lastElementChild!.remove();
  }

  private isWideCell(line: Cell[], index: number): boolean {
    return index + 1 < line.length && line[index + 1]!.ch === '';
  }

  private emitRun(element: HTMLElement, text: string, attr: CellAttr, width = 1, link = safeLink(attr.link)): void {
    let fg = attr.fg;
    let bg = attr.bg;
    if (attr.reverse) {
      const t = fg;
      fg = bg;
      bg = t;
      if (fg < 0) fg = 15;
      if (bg < 0) bg = 0;
    }
    const fgColor = colorOf(fg, 'var(--ct-fg)');
    const bgColor = colorOf(bg, attr.reverse ? 'var(--ct-fg)' : 'transparent');
    const styleValues: Array<[string, string]> = [
      ['color', fgColor === 'var(--ct-fg)' ? '' : fgColor],
      ['background', bgColor === 'transparent' ? '' : bgColor],
      ['font-weight', attr.bold ? 'bold' : ''],
      ['font-style', attr.italic ? 'italic' : ''],
      ['text-decoration', attr.underline ? 'underline' : ''],
      ['display', width === 2 ? 'inline-block' : ''],
      ['width', width === 2 ? `${this.charWidth * 2}px` : ''],
    ];
    for (const [property, value] of styleValues) {
      if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
    }
    if (link) {
      element.className = 'cloudterm-link';
      element.setAttribute('href', link);
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    } else {
      element.className = '';
      element.removeAttribute('href');
      element.removeAttribute('target');
      element.removeAttribute('rel');
    }
    if (element.textContent !== text) element.textContent = text;
  }

  scrollToBottom(): void {
    this.stickBottom = true;
    this.paint();
  }

  destroy(): void {
    this.rendered.clear();
    this.root.remove();
  }
}
