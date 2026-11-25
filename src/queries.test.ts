import { describe, expect, test } from 'bun:test';
import { createHeadless } from './headless.js';

describe('terminal query replies', () => {
  test('answers DA1, DA2, DA3, DSR 5n, DSR 6n, XTVERSION and OSC 10/11/12 queries', () => {
    const replies: string[] = [];
    const term = createHeadless(80, 24, {
      reply: (text) => { replies.push(text); },
      themeFg: '#e6e8eb',
      themeBg: '#0b0c10',
      themeCursor: '#7cc4ff',
      version: '0.0.17',
    });

    term.feedString('\x1b[3;7H');
    term.feedString('\x1b[c\x1b[>c\x1b[=c\x1b[5n\x1b[6n\x1b[>q');
    term.feedString('\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]12;?\x07');

    expect(replies).toEqual([
      '\x1b[?1;2c',
      '\x1b[>100;0;0c',
      '\x1bP!|00000000\x1b\\',
      '\x1b[0n',
      '\x1b[3;7R',
      '\x1bP>|cloudterm 0.0.17\x1b\\',
      '\x1b]10;rgb:e6e6/e8e8/ebeb\x1b\\',
      '\x1b]11;rgb:0b0b/0c0c/1010\x1b\\',
      '\x1b]12;rgb:7c7c/c4c4/ffff\x1b\\',
    ]);
  });

  test('ignores private DSR without emitting false status', () => {
    const replies: string[] = [];
    const term = createHeadless(80, 24, { reply: (text) => { replies.push(text); } });
    term.feedString('\x1b[?996n');
    expect(replies).toEqual([]);
  });
});
