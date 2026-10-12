import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { Grid } from './grid.js';
import { defaultAttr } from './parser.js';
import { DomRenderer, defaultTheme } from './renderer.js';

const window = new Window();
Object.assign(globalThis, { window, document: window.document });

function createRenderer(cols = 4, rows = 1): { renderer: DomRenderer; grid: Grid } {
  const grid = new Grid(cols, rows);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const renderer = new DomRenderer(host, grid, defaultTheme);
  renderer.charWidth = 8;
  renderer.lineHeight = 16;
  Object.defineProperty(renderer.viewport, 'clientHeight', { configurable: true, value: rows * 16 });
  return { renderer, grid };
}

function oldColorOf(n: number, fallback: string): string {
  const rgbHex = (r: number, g: number, b: number): string => '#' + [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('');
  const palette = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
  const xterm256Color = (index: number): string => {
    if (index < 16) return palette[index]!;
    if (index >= 232) {
      const value = 8 + (index - 232) * 10;
      return rgbHex(value, value, value);
    }
    const value = index - 16;
    const map = [0, 95, 135, 175, 215, 255];
    return rgbHex(map[Math.floor(value / 36)]!, map[Math.floor((value % 36) / 6)]!, map[value % 6]!);
  };
  if (n < 0) return fallback;
  if (n & 0x01000000) return rgbHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  return n < 256 ? xterm256Color(n) : fallback;
}

describe('DomRenderer', () => {
  test('reuses spans when a line changes', () => {
    const { renderer, grid } = createRenderer();
    grid.writeChar('a', defaultAttr());
    renderer.paint();
    const span = renderer.surface.querySelector('.cloudterm-line span')!;
    grid.screen[0]![0] = { ch: 'b', attr: defaultAttr() };
    grid.dirtyAll = true;
    renderer.paint();
    const updated = renderer.surface.querySelector('.cloudterm-line span')!;
    expect(updated).toBe(span);
    expect(updated.textContent).toBe('b   ');
  });

  test('clears styles on a reused span', () => {
    const { renderer, grid } = createRenderer();
    const redBold = { ...defaultAttr(), fg: 1, bold: true };
    grid.writeChar('a', redBold);
    renderer.paint();
    const span = renderer.surface.querySelector('.cloudterm-line span') as HTMLSpanElement;
    grid.screen[0]![0] = { ch: 'a', attr: defaultAttr() };
    grid.dirtyAll = true;
    renderer.paint();
    expect(span.style.fontWeight).toBe('');
    expect(span.style.color).toBe('');
  });

  test('reuses pooled line divs after scrolling', () => {
    const { renderer, grid } = createRenderer(2, 2);
    (renderer as unknown as { overscan: number }).overscan = 0;
    (renderer as unknown as { stickBottom: boolean }).stickBottom = false;
    grid.cursorRow = 1;
    grid.lineFeed();
    renderer.paint();
    renderer.viewport.scrollTop = 16;
    renderer.paint();
    expect((renderer as unknown as { linePool: HTMLDivElement[] }).linePool).toHaveLength(1);
    renderer.viewport.scrollTop = 0;
    renderer.paint();
    expect((renderer as unknown as { linePool: HTMLDivElement[] }).linePool).toHaveLength(0);
  });

  test('keeps a screen of rows rendered above and below the viewport by default', () => {
    const { renderer, grid } = createRenderer(4, 10);
    grid.cursorRow = 9;
    for (let i = 0; i < 60; i++) grid.lineFeed();
    (renderer as unknown as { stickBottom: boolean }).stickBottom = false;
    const firstVisible = 30;
    renderer.viewport.scrollTop = firstVisible * renderer.lineHeight;
    renderer.paint();
    const rendered = [...(renderer as unknown as { rendered: Map<number, HTMLDivElement> }).rendered.keys()];
    expect(Math.min(...rendered)).toBeLessThanOrEqual(grid.trimmed + firstVisible - grid.rows);
    expect(Math.max(...rendered)).toBeGreaterThanOrEqual(grid.trimmed + firstVisible + grid.rows * 2 - 1);
  });

  test('matches the previous palette and truecolor output', () => {
    const { renderer } = createRenderer();
    const emitRun = (renderer as unknown as { emitRun(span: HTMLSpanElement, text: string, attr: ReturnType<typeof defaultAttr>): void }).emitRun.bind(renderer);
    for (let index = 0; index < 256; index++) {
      const span = document.createElement('span');
      emitRun(span, 'x', { ...defaultAttr(), fg: index });
      expect(span.style.color).toBe(oldColorOf(index, 'var(--ct-fg)'));
    }
    for (const color of [0x01000000, 0x01123456, 0x01ff00aa]) {
      const span = document.createElement('span');
      emitRun(span, 'x', { ...defaultAttr(), fg: color });
      expect(span.style.color).toBe(oldColorOf(color, 'var(--ct-fg)'));
    }
  });

  test('skips wide-character continuation cells', () => {
    const { renderer, grid } = createRenderer();
    grid.writeChar('界', defaultAttr());
    renderer.paint();
    const spans = renderer.surface.querySelectorAll('.cloudterm-line span');
    expect(spans).toHaveLength(2);
    expect(spans[0]!.textContent).toBe('界');
    expect(spans[0]!.style.width).toBe('16px');
    expect(spans[1]!.textContent).toBe('  ');
  });

  test('renders linked runs as safe anchors and replaces them with spans', () => {
    const { renderer, grid } = createRenderer();
    grid.writeChar('a', { ...defaultAttr(), link: 'https://example.com/docs' });
    renderer.paint();
    const anchor = renderer.surface.querySelector('.cloudterm-line a')!;
    expect(anchor.getAttribute('href')).toBe('https://example.com/docs');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    grid.screen[0]![0] = { ch: 'a', attr: defaultAttr() };
    grid.dirtyAll = true;
    renderer.paint();
    expect(renderer.surface.querySelector('.cloudterm-line span')).not.toBeNull();
    expect(renderer.surface.querySelector('.cloudterm-line a')).toBeNull();
  });

  test('does not render unsafe links', () => {
    const { renderer, grid } = createRenderer();
    grid.writeChar('a', { ...defaultAttr(), link: 'javascript:alert(1)' });
    renderer.paint();
    expect(renderer.surface.querySelector('.cloudterm-line a')).toBeNull();
  });

  test('positions and clears the search highlight', () => {
    const { renderer, grid } = createRenderer(12, 2);
    grid.writeAscii('foo 日本 bar', defaultAttr());
    renderer.paint();
    renderer.setSearchMatch({ line: 0, col: 4, length: 8 });
    const highlight = renderer.surface.querySelector('.cloudterm-search-match') as HTMLSpanElement;
    expect(highlight.style.display).toBe('block');
    expect(highlight.style.left).toBe('32px');
    expect(highlight.style.top).toBe('0px');
    expect(highlight.style.width).toBe('64px');
    expect(highlight.style.height).toBe('16px');
    renderer.setSearchMatch(null);
    expect(highlight.style.display).toBe('none');
  });

  test('scrollToLine leaves stick-to-bottom so the match stays in view', () => {
    const { renderer, grid } = createRenderer(12, 4);
    for (let i = 0; i < 100; i++) {
      grid.writeAscii(`row ${i}`, defaultAttr());
      grid.carriageReturn();
      grid.lineFeed();
    }
    let scrollTop = 0;
    Object.defineProperty(renderer.viewport, 'scrollHeight', { configurable: true, get: () => grid.totalLines() * 16 });
    Object.defineProperty(renderer.viewport, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    renderer.paint();
    expect(scrollTop).toBe(grid.totalLines() * 16 - 64);
    renderer.scrollToLine(grid.trimmed + 10);
    renderer.paint();
    expect(scrollTop).toBe(10 * 16 - 24);
  });
});
