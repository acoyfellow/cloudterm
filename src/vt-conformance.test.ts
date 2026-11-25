import { describe, expect, test } from 'bun:test';
import { createHeadless } from './headless.js';

const rowText = (term: ReturnType<typeof createHeadless>, row: number) =>
  term.grid.screen[row]!.map((c) => c.ch).join('').trimEnd();

describe('VT conformance features', () => {
  test('DEC Special Graphics G0 maps line-drawing bytes and returns to ASCII', () => {
    const term = createHeadless(40, 5);
    term.feedString('\x1b(0lqqqk\x1b(B-ok');
    expect(rowText(term, 0)).toBe('┌───┐-ok');
  });

  test('TBC and HTS configure custom tab stops', () => {
    const term = createHeadless(40, 5);
    term.feedString('a\tb\r\n\x1b[3g\x1b[2;5H\x1bH\x1b[2;1H1\t2');
    expect(rowText(term, 0)).toBe('a       b');
    expect(rowText(term, 1)).toBe('1   2');
  });

  test('resize reflows wrapped lines across shrink and widen without truncating', () => {
    const term = createHeadless(120, 10);
    const line = 'START-' + 'x'.repeat(90) + '-END';
    term.feedString(line + '\r\n');
    term.resize(60, 10);
    expect(rowText(term, 0).length).toBe(60);
    expect(rowText(term, 1)).toBe('x'.repeat(36) + '-END');
    term.resize(120, 10);
    expect(rowText(term, 0)).toBe(line);
  });
});
