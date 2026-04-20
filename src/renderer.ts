// DOM renderer. Pretext-aware measurement. Line virtualization.
//
// Host layout (all inside the mount element):
//   .cloudterm                     position:relative, scrolls via inner viewport
//     .cloudterm-viewport          overflow:auto
//       .cloudterm-sizer           height = totalLines * lineHeight (absolute spacer)
//       .cloudterm-surface         absolute, translated by scrollTop, contains visible line divs
//     textarea.cloudterm-input     offscreen
//
// Each line is a <div class="cloudterm-line"> with absolute top.
// Inside each line, runs of same-styled text are <span>s.

import { prepare, layout } from '@chenglou/pretext';
import type { CellAttr } from './parser.js';
import type { Cell } from './grid.js';
import { Grid } from './grid.js';

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

function rgbHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function colorOf(n: number, fallback: string): string {
  if (n < 0) return fallback;
  if (n & 0x01000000) {
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    return rgbHex(r, g, b);
  }
  if (n < 256) return xterm256Color(n);
  return fallback;
}

function attrKey(a: CellAttr): string {
  // Fast key to group runs. Boolean bits packed.
  const flags =
    (a.bold ? 1 : 0) |
    (a.italic ? 2 : 0) |
    (a.underline ? 4 : 0) |
    (a.reverse ? 8 : 0);
  return `${a.fg}|${a.bg}|${flags}`;
}

export class DomRenderer {
  host: HTMLElement;
  theme: Theme;
  grid: Grid;

  root: HTMLDivElement;
  viewport: HTMLDivElement;
  sizer: HTMLDivElement;
  surface: HTMLDivElement;

  charWidth = 8;
  lineHeight = 16;
  private stickBottom = true;

  // Virtualization: track rendered line indexes -> their divs.
  private rendered = new Map<number, HTMLDivElement>();
  private overscan = 4;

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
    this.viewport.appendChild(this.sizer);
    this.viewport.appendChild(this.surface);
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

    const first = Math.max(0, Math.floor(scrollTop / this.lineHeight) - this.overscan);
    const last = Math.min(
      total - 1,
      Math.ceil((scrollTop + vpHeight) / this.lineHeight) + this.overscan,
    );

    // Remove stale
    for (const [idx, el] of this.rendered) {
      if (idx < first || idx > last) {
        el.remove();
        this.rendered.delete(idx);
      }
    }

    // Add / update visible
    for (let i = first; i <= last; i++) {
      const line = this.grid.getLine(i);
      const existing = this.rendered.get(i);
      if (existing) {
        existing.style.top = `${i * this.lineHeight}px`;
        this.renderLineInto(existing, line, i);
        continue;
      }
      const div = document.createElement('div');
      div.className = 'cloudterm-line';
      div.style.top = `${i * this.lineHeight}px`;
      div.style.height = `${this.lineHeight}px`;
      this.renderLineInto(div, line, i);
      this.surface.appendChild(div);
      this.rendered.set(i, div);
    }

    this.grid.dirty = false;
  }

  private renderLineInto(div: HTMLDivElement, line: Cell[], lineIndex: number): void {
    // Clear
    div.textContent = '';
    // Determine if this line contains cursor.
    const cursorLineIndex = this.grid.scrollback.length + this.grid.cursorRow;
    const hasCursor =
      this.grid.cursorVisible && lineIndex === cursorLineIndex;

    // Build runs of same-styled cells.
    let runStart = 0;
    let runKey = line.length ? attrKey(line[0]!.attr) : '';
    let runBuf = line.length ? line[0]!.ch : '';
    for (let i = 1; i < line.length; i++) {
      const cell = line[i]!;
      const key = attrKey(cell.attr);
      if (key === runKey) {
        runBuf += cell.ch;
      } else {
        this.emitRun(div, runBuf, line[runStart]!.attr);
        runStart = i;
        runKey = key;
        runBuf = cell.ch;
      }
    }
    if (runBuf.length) this.emitRun(div, runBuf, line[runStart]!.attr);

    if (hasCursor) {
      const cursorEl = document.createElement('span');
      cursorEl.className = 'cloudterm-cursor';
      cursorEl.style.left = `${this.grid.cursorCol * this.charWidth}px`;
      cursorEl.style.width = `${this.charWidth}px`;
      cursorEl.style.height = `${this.lineHeight}px`;
      div.appendChild(cursorEl);
    }
  }

  private emitRun(parent: HTMLDivElement, text: string, attr: CellAttr): void {
    if (!text.length) return;
    const span = document.createElement('span');
    let fg = attr.fg;
    let bg = attr.bg;
    if (attr.reverse) {
      const t = fg;
      fg = bg;
      bg = t;
      // Map defaults: swap foreground <-> background default.
      if (fg < 0) fg = 15; // placeholder: colorOf handles negative using fallback
      if (bg < 0) bg = 0;
    }
    const fgColor = colorOf(fg, 'var(--ct-fg)');
    const bgColor = colorOf(bg, attr.reverse ? 'var(--ct-fg)' : 'transparent');
    if (fgColor !== 'var(--ct-fg)') span.style.color = fgColor;
    if (bgColor !== 'transparent') span.style.background = bgColor;
    if (attr.bold) span.style.fontWeight = 'bold';
    if (attr.italic) span.style.fontStyle = 'italic';
    if (attr.underline) span.style.textDecoration = 'underline';
    span.textContent = text;
    parent.appendChild(span);
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
