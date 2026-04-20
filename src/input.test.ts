import { describe, test, expect } from 'bun:test';
import { keyToBytes, type KeyLike } from './input.js';

function k(partial: Partial<KeyLike> & { key: string }): KeyLike {
  return {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...partial,
  };
}

function bytesToStr(b: Uint8Array | null): string | null {
  if (!b) return null;
  return new TextDecoder().decode(b);
}

describe('keyToBytes', () => {
  test('plain printable char returns null (input event path)', () => {
    expect(keyToBytes(k({ key: 'a' }))).toBeNull();
    expect(keyToBytes(k({ key: 'A', shiftKey: true }))).toBeNull();
    expect(keyToBytes(k({ key: '1' }))).toBeNull();
    expect(keyToBytes(k({ key: ' ' }))).toBeNull();
  });

  test('arrow keys', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'ArrowUp' })))).toBe('\x1b[A');
    expect(bytesToStr(keyToBytes(k({ key: 'ArrowDown' })))).toBe('\x1b[B');
    expect(bytesToStr(keyToBytes(k({ key: 'ArrowRight' })))).toBe('\x1b[C');
    expect(bytesToStr(keyToBytes(k({ key: 'ArrowLeft' })))).toBe('\x1b[D');
  });

  test('alt + arrow produces double-ESC sequence', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'ArrowUp', altKey: true })))).toBe('\x1b\x1b[A');
    expect(bytesToStr(keyToBytes(k({ key: 'ArrowLeft', altKey: true })))).toBe('\x1b\x1b[D');
  });

  test('Enter produces CR', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Enter' })))).toBe('\r');
  });

  test('Backspace produces DEL; Ctrl+Backspace produces BS', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Backspace' })))).toBe('\x7f');
    expect(bytesToStr(keyToBytes(k({ key: 'Backspace', ctrlKey: true })))).toBe('\x08');
  });

  test('Tab / Shift+Tab', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Tab' })))).toBe('\t');
    expect(bytesToStr(keyToBytes(k({ key: 'Tab', shiftKey: true })))).toBe('\x1b[Z');
  });

  test('Escape', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Escape' })))).toBe('\x1b');
  });

  test('Home / End / PageUp / PageDown / Delete', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Home' })))).toBe('\x1b[H');
    expect(bytesToStr(keyToBytes(k({ key: 'End' })))).toBe('\x1b[F');
    expect(bytesToStr(keyToBytes(k({ key: 'PageUp' })))).toBe('\x1b[5~');
    expect(bytesToStr(keyToBytes(k({ key: 'PageDown' })))).toBe('\x1b[6~');
    expect(bytesToStr(keyToBytes(k({ key: 'Delete' })))).toBe('\x1b[3~');
  });

  test('Insert produces CSI 2~; Shift+Insert defers to paste event', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Insert' })))).toBe('\x1b[2~');
    expect(keyToBytes(k({ key: 'Insert', shiftKey: true }))).toBeNull();
  });

  test('Ctrl+C / Ctrl+D / Ctrl+Z produce SIGINT / EOF / SUSP', () => {
    expect(keyToBytes(k({ key: 'c', ctrlKey: true }))).toEqual(new Uint8Array([0x03]));
    expect(keyToBytes(k({ key: 'd', ctrlKey: true }))).toEqual(new Uint8Array([0x04]));
    expect(keyToBytes(k({ key: 'z', ctrlKey: true }))).toEqual(new Uint8Array([0x1a]));
  });

  test('Ctrl+letter is case-insensitive (shift still maps to lower control code)', () => {
    expect(keyToBytes(k({ key: 'A', ctrlKey: true, shiftKey: true }))).toEqual(new Uint8Array([0x01]));
    expect(keyToBytes(k({ key: 'a', ctrlKey: true }))).toEqual(new Uint8Array([0x01]));
  });

  test('Ctrl + punctuation controls', () => {
    expect(keyToBytes(k({ key: '[', ctrlKey: true }))).toEqual(new Uint8Array([0x1b]));
    expect(keyToBytes(k({ key: '\\', ctrlKey: true }))).toEqual(new Uint8Array([0x1c]));
    expect(keyToBytes(k({ key: ']', ctrlKey: true }))).toEqual(new Uint8Array([0x1d]));
    expect(keyToBytes(k({ key: '^', ctrlKey: true }))).toEqual(new Uint8Array([0x1e]));
    expect(keyToBytes(k({ key: '_', ctrlKey: true }))).toEqual(new Uint8Array([0x1f]));
    expect(keyToBytes(k({ key: ' ', ctrlKey: true }))).toEqual(new Uint8Array([0x00]));
  });

  test('Alt + printable -> ESC prefix', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'a', altKey: true })))).toBe('\x1ba');
    expect(bytesToStr(keyToBytes(k({ key: 'b', altKey: true })))).toBe('\x1bb');
    expect(bytesToStr(keyToBytes(k({ key: '.', altKey: true })))).toBe('\x1b.');
  });

  test('Meta (Cmd) shortcuts pass through as null', () => {
    expect(keyToBytes(k({ key: 'c', metaKey: true }))).toBeNull();
    expect(keyToBytes(k({ key: 'v', metaKey: true }))).toBeNull();
    expect(keyToBytes(k({ key: 'a', metaKey: true }))).toBeNull();
    // Meta + arrow is also a browser/OS concern, should pass through.
    expect(keyToBytes(k({ key: 'ArrowLeft', metaKey: true }))).toBeNull();
  });

  test('function keys', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'F1' })))).toBe('\x1bOP');
    expect(bytesToStr(keyToBytes(k({ key: 'F2' })))).toBe('\x1bOQ');
    expect(bytesToStr(keyToBytes(k({ key: 'F3' })))).toBe('\x1bOR');
    expect(bytesToStr(keyToBytes(k({ key: 'F4' })))).toBe('\x1bOS');
    expect(bytesToStr(keyToBytes(k({ key: 'F5' })))).toBe('\x1b[15~');
    expect(bytesToStr(keyToBytes(k({ key: 'F6' })))).toBe('\x1b[17~');
    expect(bytesToStr(keyToBytes(k({ key: 'F7' })))).toBe('\x1b[18~');
    expect(bytesToStr(keyToBytes(k({ key: 'F8' })))).toBe('\x1b[19~');
    expect(bytesToStr(keyToBytes(k({ key: 'F9' })))).toBe('\x1b[20~');
    expect(bytesToStr(keyToBytes(k({ key: 'F10' })))).toBe('\x1b[21~');
    expect(bytesToStr(keyToBytes(k({ key: 'F11' })))).toBe('\x1b[23~');
    expect(bytesToStr(keyToBytes(k({ key: 'F12' })))).toBe('\x1b[24~');
  });

  test('Dead key returns null (lets IME composition flow through input event)', () => {
    expect(keyToBytes(k({ key: 'Dead' }))).toBeNull();
  });

  test('Unidentified / modifier-only keys return null', () => {
    expect(keyToBytes(k({ key: 'Shift' }))).toBeNull();
    expect(keyToBytes(k({ key: 'Control' }))).toBeNull();
    expect(keyToBytes(k({ key: 'Alt' }))).toBeNull();
    expect(keyToBytes(k({ key: 'Meta' }))).toBeNull();
  });
});
