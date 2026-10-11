import { describe, expect, test } from 'bun:test';
import { encodeMouse, mapMouseCoordinates } from './mouse.js';

describe('encodeMouse', () => {
  test('encodes legacy press and release', () => {
    expect(encodeMouse({ kind: 'press', button: 0, col: 2, row: 3, shift: false, alt: false, ctrl: false }, { tracking: 1000, sgr: false })).toBe('\x1b[M\x20\x22\x23');
    expect(encodeMouse({ kind: 'release', button: 0, col: 2, row: 3, shift: false, alt: false, ctrl: false }, { tracking: 1000, sgr: false })).toBe('\x1b[M\x23\x22\x23');
  });

  test('encodes SGR button, motion, and wheel events', () => {
    expect(encodeMouse({ kind: 'press', button: 2, col: 4, row: 5, shift: false, alt: false, ctrl: true }, { tracking: 1000, sgr: true })).toBe('\x1b[<18;4;5M');
    expect(encodeMouse({ kind: 'move', button: 0, col: 4, row: 5, shift: false, alt: false, ctrl: false }, { tracking: 1002, sgr: true })).toBe('\x1b[<32;4;5M');
    expect(encodeMouse({ kind: 'move', button: 3, col: 4, row: 5, shift: false, alt: false, ctrl: false }, { tracking: 1003, sgr: true })).toBe('\x1b[<35;4;5M');
    expect(encodeMouse({ kind: 'wheel', button: 3, col: 4, row: 5, shift: false, alt: false, ctrl: false, wheelUp: true }, { tracking: 1000, sgr: true })).toBe('\x1b[<64;4;5M');
    expect(encodeMouse({ kind: 'wheel', button: 3, col: 4, row: 5, shift: false, alt: false, ctrl: false, wheelUp: false }, { tracking: 1000, sgr: true })).toBe('\x1b[<65;4;5M');
  });

  test('drops unsupported tracking events and oversized legacy coordinates', () => {
    expect(encodeMouse({ kind: 'move', button: 0, col: 2, row: 3, shift: false, alt: false, ctrl: false }, { tracking: 1000, sgr: false })).toBeNull();
    expect(encodeMouse({ kind: 'press', button: 0, col: 224, row: 1, shift: false, alt: false, ctrl: false }, { tracking: 1000, sgr: false })).toBeNull();
    expect(encodeMouse({ kind: 'press', button: 0, col: 300, row: 1, shift: false, alt: false, ctrl: false }, { tracking: 1000, sgr: true })).toBe('\x1b[<0;300;1M');
  });
});

describe('mapMouseCoordinates', () => {
  test('maps client coordinates through viewport scrolling to screen cells', () => {
    expect(mapMouseCoordinates({ clientX: 26, clientY: 45, rect: { left: 10, top: 20 }, charWidth: 8, lineHeight: 16, scrollTop: 48, screenTop: 32 })).toEqual({ col: 3, row: 3 });
  });
});

describe('mapMouseCoordinates', () => {
  const base = { rect: { left: 10, top: 20 }, charWidth: 8, lineHeight: 16 };
  test('maps the top-left cell of the visible screen to 1,1', () => {
    expect(mapMouseCoordinates({ ...base, clientX: 10, clientY: 20, scrollTop: 0, screenTop: 0 })).toEqual({ col: 1, row: 1 });
  });
  test('accounts for scrollback above the screen', () => {
    const screenTop = 100 * 16;
    expect(mapMouseCoordinates({ ...base, clientX: 10 + 8 * 4 + 3, clientY: 20 + 16 * 2 + 5, scrollTop: screenTop, screenTop })).toEqual({ col: 5, row: 3 });
  });
});
