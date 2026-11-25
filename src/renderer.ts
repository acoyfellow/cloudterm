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
import type { RenderLine } from './grid.js';
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
  const map = [0, 95, 135, 175, 215, 255];
  return rgbHex(map[i / 36 | 0]!, map[i % 36 / 6 | 0]!, map[i % 6]!);
}

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
  if (n < 256) return xterm256Color(n);
  return fallback;
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
  searchEl: HTMLSpanElement;
  predictLayer: HTMLDivElement;
  searchMatch: { line: number; col: number; length: number } | null = null;

  charWidth = 8;
  lineHeight = 16;
  private stickBottom = true;

  // Virtualization: track rendered line indexes -> their divs.
  private rendered = new Map<number, HTMLDivElement>();
  private linePool: HTMLDivElement[] = [];
  private overscan: number | null = null;
  private hadPredictions = false;
  private runState = new WeakMap<HTMLElement, { key: string; text: string; styled: boolean; linked: boolean }>();
  private lineTop = new WeakMap<HTMLElement, number>();
  private styles = new Map<string, string>();
  private attrIds = new WeakMap<CellAttr, number>();
  private nextAttrId = 0;
  private lastTargetHeight = -1;
  private lastVpHeight = 0;
  private lastScrollTop = 0;
  private lastTrimmed = -1;
  private lastFirst = -1;
  private lastLast = -1;
  private lastCursorKey = '';
  private lastSearchKey = '';

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
    this.searchEl = document.createElement('span');
    this.searchEl.className = 'cloudterm-search-match';
    // Prediction overlay lives above lines, below cursor's blend layer. Its
    // children are absolute-positioned ghost glyphs rebuilt every paint.
    this.predictLayer = document.createElement('div');
    this.predictLayer.className = 'cloudterm-predictions';
    this.viewport.appendChild(this.sizer);
    this.viewport.appendChild(this.surface);
    this.surface.appendChild(this.predictLayer);
    this.surface.appendChild(this.searchEl);
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
      this.lastVpHeight = vp.clientHeight;
      this.lastScrollTop = vp.scrollTop;
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
    this.lastVpHeight = this.viewport.clientHeight;
    this.lastTargetHeight = -1;
    if (cols === prev.cols && rows === prev.rows) return false;
    this.grid.resize(cols, rows);
    return true;
  }

  paint(): void {
    const total = this.grid.totalLines();
    const targetHeight = total * this.lineHeight;
    const heightChanged = targetHeight !== this.lastTargetHeight;
    if (heightChanged) {
      this.lastTargetHeight = targetHeight;
      this.sizer.style.height = `${targetHeight}px`;
    }

    const vp = this.viewport;
    let vpHeight = this.lastVpHeight;
    let scrollTop = this.lastScrollTop;
    if (heightChanged || vpHeight === 0) {
      vpHeight = vp.clientHeight || this.grid.rows * this.lineHeight;
      this.lastVpHeight = vpHeight;
      if (this.stickBottom) {
        scrollTop = Math.max(0, targetHeight - vpHeight);
        if (vp.scrollTop !== scrollTop) vp.scrollTop = scrollTop;
      } else {
        scrollTop = vp.scrollTop;
      }
      this.lastScrollTop = scrollTop;
    } else if (!this.stickBottom) {
      scrollTop = vp.scrollTop;
      this.lastScrollTop = scrollTop;
    }

    const overscan = this.overscan ?? (this.stickBottom ? 2 : this.grid.rows);
    const trimmed = this.grid.trimmed;
    const first = trimmed + Math.max(0, Math.floor(scrollTop / this.lineHeight) - overscan);
    const last = trimmed + Math.min(
      total - 1,
      Math.ceil((scrollTop + vpHeight) / this.lineHeight) + overscan,
    );

    // Consume dirty state once per paint. After this call, the grid has no
    // record of what changed; any subsequent mutation will mark itself dirty
    // for the next paint.
    const { dirtyAll, dirtyLines } = this.grid.consumeDirty();

    const sameWindow = first === this.lastFirst && last === this.lastLast && trimmed === this.lastTrimmed;
    if (sameWindow && !dirtyAll && dirtyLines.size <= 8) {
      for (const idx of dirtyLines) {
        if (idx < first || idx > last) continue;
        const existing = this.rendered.get(idx);
        if (existing) this.renderLineInto(existing, this.grid.renderLine(idx));
      }
    } else {
      const reusable: HTMLDivElement[] = [];
      for (const [idx, el] of this.rendered) {
        if (idx < first || idx > last) {
          this.rendered.delete(idx);
          reusable.push(el);
        }
      }

      for (let i = first; i <= last; i++) {
        const existing = this.rendered.get(i);
        const topPx = (i - trimmed) * this.lineHeight;
        const mustRebuild = dirtyAll || dirtyLines.has(i);
        if (existing) {
          if (this.lineTop.get(existing) !== topPx) {
            existing.style.top = `${topPx}px`;
            this.lineTop.set(existing, topPx);
          }
          if (mustRebuild) {
            this.renderLineInto(existing, this.grid.renderLine(i));
          }
          continue;
        }
        const reused = reusable.pop();
        if (reused) {
          if (this.lineTop.get(reused) !== topPx) {
            reused.style.top = `${topPx}px`;
            this.lineTop.set(reused, topPx);
          }
          this.renderLineInto(reused, this.grid.renderLine(i));
          this.rendered.set(i, reused);
          continue;
        }
        const div = this.linePool.pop() ?? document.createElement('div');
        div.className = 'cloudterm-line';
        div.style.top = `${topPx}px`;
        div.style.height = `${this.lineHeight}px`;
        this.lineTop.set(div, topPx);
        this.renderLineInto(div, this.grid.renderLine(i));
        this.surface.appendChild(div);
        this.rendered.set(i, div);
      }
      for (const leftover of reusable) {
        leftover.remove();
        if (this.linePool.length < this.grid.rows * 4) this.linePool.push(leftover);
      }
      this.lastFirst = first;
      this.lastLast = last;
      this.lastTrimmed = trimmed;
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
    this.positionSearchMatch();
  }

  setSearchMatch(match: { line: number; col: number; length: number } | null): void {
    this.searchMatch = match;
    this.positionSearchMatch();
  }

  private positionSearchMatch(): void {
    const match = this.searchMatch;
    if (!match) {
      if (this.lastSearchKey !== '') {
        this.lastSearchKey = '';
        this.searchEl.style.display = 'none';
      }
      return;
    }
    const top = (match.line - this.grid.trimmed) * this.lineHeight;
    const left = match.col * this.charWidth;
    const width = match.length * this.charWidth;
    const key = `${top}:${left}:${width}:${this.lineHeight}`;
    if (key === this.lastSearchKey) return;
    this.lastSearchKey = key;
    this.searchEl.style.display = 'block';
    this.searchEl.style.top = `${top}px`;
    this.searchEl.style.left = `${left}px`;
    this.searchEl.style.width = `${width}px`;
    this.searchEl.style.height = `${this.lineHeight}px`;
  }

  private positionCursor(): void {
    if (!this.grid.cursorVisible) {
      if (this.lastCursorKey !== 'off') {
        this.lastCursorKey = 'off';
        this.cursorEl.style.display = 'none';
      }
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
    const top = (cursorAbs - this.grid.trimmed) * this.lineHeight;
    const left = col * this.charWidth;
    const key = `${top}:${left}:${this.charWidth}:${this.lineHeight}`;
    if (key === this.lastCursorKey) return;
    this.lastCursorKey = key;
    this.cursorEl.style.display = '';
    this.cursorEl.style.top = `${top}px`;
    this.cursorEl.style.left = `${left}px`;
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

  private renderLineInto(div: HTMLDivElement, line: RenderLine): void {
    const codes = line.codes;
    const charMask = 0xffff;
    let end = codes.length;
    while (end > 0) {
      const code = line.needsClear && end - 1 >= line.clearStart ? 32 : codes[end - 1]!;
      const ch = code & charMask;
      const attr = line.attrs[code >>> 16]!;
      if ((ch === 0 || ch === 32) && attr.bg < 0 && !attr.reverse && !attr.underline && !attr.link) end--;
      else break;
    }
    const runs: Array<{ text: string; attr: CellAttr; attrId: number; width: number }> = [];
    let runAttrId = -1;
    let runBuf = '';
    const flush = (): void => {
      if (runBuf) runs.push({ text: runBuf, attr: line.attrs[runAttrId]!, attrId: runAttrId, width: 1 });
      runAttrId = -1;
      runBuf = '';
    };
    for (let i = 0; i < end; i++) {
      const code = line.needsClear && i >= line.clearStart ? 32 : codes[i]!;
      const charCode = code & charMask;
      if (charCode === 0) continue;
      const attrId = code >>> 16;
      const ch = charCode < 128 ? String.fromCharCode(charCode) : line.strings[charCode - 128]!;
      const next = charCode >= 128 && i + 1 < codes.length && !(line.needsClear && i + 1 >= line.clearStart) ? codes[i + 1]! & charMask : 32;
      if (next === 0 && wcwidth(ch) === 2) {
        flush();
        runs.push({ text: ch, attr: line.attrs[attrId]!, attrId, width: 2 });
      } else if (attrId === runAttrId) runBuf += ch;
      else {
        flush();
        runAttrId = attrId;
        runBuf = ch;
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
      this.emitRun(element, run.text, run.attr, run.width, link, run.attrId);
      if (!element.parentElement) div.appendChild(element);
    }
    while (div.children.length > runs.length) div.lastElementChild!.remove();
  }

  private emitRun(element: HTMLElement, text: string, attr: CellAttr, width = 1, link = safeLink(attr.link), attrId = -1): void {
    let fg = attr.fg;
    let bg = attr.bg;
    if (attr.reverse) {
      const t = fg;
      fg = bg;
      bg = t;
      if (fg < 0) fg = 15;
      if (bg < 0) bg = 0;
    }
    let styleId = `g${attrId}`;
    if (attrId < 0) {
      let id = this.attrIds.get(attr);
      if (id === undefined) {
        id = this.nextAttrId++;
        this.attrIds.set(attr, id);
      }
      styleId = `d${id}`;
    }
    const key = `${styleId}:${width}:${this.charWidth}`;
    const state = this.runState.get(element);
    let styled = state?.styled ?? false;
    let linked = state?.linked ?? false;
    if (!state || state.key !== key) {
      let style = this.styles.get(key);
      if (style === undefined) {
        const fgColor = colorOf(fg, 'var(--ct-fg)');
        const bgColor = colorOf(bg, attr.reverse ? 'var(--ct-fg)' : 'transparent');
        let s = '';
        if (fgColor !== 'var(--ct-fg)') s += `color:${fgColor};`;
        if (bgColor !== 'transparent') s += `background:${bgColor};`;
        if (attr.bold) s += 'font-weight:bold;';
        if (attr.italic) s += 'font-style:italic;';
        if (attr.underline) s += 'text-decoration:underline;';
        if (width === 2) s += `display:inline-block;width:${this.charWidth * 2}px;`;
        style = s;
        this.styles.set(key, style);
      }
      if (style) {
        element.setAttribute('style', style);
        styled = true;
      } else if (styled) {
        element.removeAttribute('style');
        styled = false;
      }
      if (link) {
        element.className = 'cloudterm-link';
        element.setAttribute('href', link);
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
        linked = true;
      } else if (linked) {
        element.className = '';
        element.removeAttribute('href');
        element.removeAttribute('target');
        element.removeAttribute('rel');
        linked = false;
      }
    }
    if (!state || state.text !== text) {
      const first = element.firstChild;
      if (first && first.nodeType === 3 && element.childNodes.length === 1) {
        (first as Text).data = text;
      } else {
        element.textContent = text;
      }
    }
    this.runState.set(element, { key, text, styled, linked });
  }

  scrollToLine(line: number): void {
    const vp = this.viewport;
    const top = (line - this.grid.trimmed) * this.lineHeight;
    const target = Math.max(0, top - Math.max(0, vp.clientHeight - this.lineHeight) / 2);
    const bottom = Math.max(0, vp.scrollHeight - vp.clientHeight);
    this.stickBottom = target >= bottom;
    vp.scrollTop = Math.min(target, bottom);
    this.paint();
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
