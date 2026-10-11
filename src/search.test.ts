import { describe, expect, test } from 'bun:test';
import { createHeadless } from './headless.js';

describe('searchGrid', () => {
  test('returns plain matches with absolute line indexes', () => {
    const terminal = createHeadless(20, 3);
    terminal.feedString('first\r\nneedle');
    expect(terminal.search('needle')).toEqual([{ line: 1, col: 0, length: 6 }]);
  });

  test('is case-insensitive by default and honors caseSensitive', () => {
    const terminal = createHeadless(20, 2);
    terminal.feedString('Needle needle');
    expect(terminal.search('needle')).toEqual([
      { line: 0, col: 0, length: 6 },
      { line: 0, col: 7, length: 6 },
    ]);
    expect(terminal.search('needle', { caseSensitive: true })).toEqual([
      { line: 0, col: 7, length: 6 },
    ]);
  });

  test('supports regular expressions and rejects invalid patterns', () => {
    const terminal = createHeadless(20, 2);
    terminal.feedString('item-42 item-99');
    expect(terminal.search('item-\\d+', { regex: true })).toEqual([
      { line: 0, col: 0, length: 7 },
      { line: 0, col: 8, length: 7 },
    ]);
    expect(terminal.search('[', { regex: true })).toEqual([]);
  });

  test('uses cell columns and lengths after wide characters', () => {
    const terminal = createHeadless(20, 2);
    terminal.feedString('foo 日本 bar');
    expect(terminal.search('bar')).toEqual([{ line: 0, col: 9, length: 3 }]);
    expect(terminal.search('日本 bar')).toEqual([{ line: 0, col: 4, length: 8 }]);
  });

  test('preserves surviving absolute indexes through scrollback eviction', () => {
    const terminal = createHeadless(20, 2, { maxScrollback: 5 });
    terminal.feedString('old\r\nkeep\r\nline-2\r\nline-3');
    const before = terminal.search('keep')[0]!;
    terminal.feedString('\r\nline-4\r\nline-5\r\nline-6\r\nline-7');
    expect(terminal.search('keep')).toEqual([before]);
    expect(terminal.search('old')).toEqual([]);
  });
});
