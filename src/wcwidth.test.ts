import { describe, expect, test } from 'bun:test';
import { wcwidth } from './wcwidth.js';

describe('wcwidth', () => {
  test('returns zero for combining and zero-width characters', () => {
    expect(wcwidth('\u0301')).toBe(0);
    expect(wcwidth('\u200d')).toBe(0);
    expect(wcwidth('\ufe0f')).toBe(0);
  });

  test('returns one for narrow characters', () => {
    expect(wcwidth('e')).toBe(1);
  });

  test('returns two for wide and emoji characters', () => {
    expect(wcwidth('日')).toBe(2);
    expect(wcwidth('\u{1f600}')).toBe(2);
  });
});

describe('wcwidth coverage', () => {
  test('treats scripts with combining marks as zero width', () => {
    expect(wcwidth('\u0915\u094d'.slice(1))).toBe(0);
    expect(wcwidth('\u0e31')).toBe(0);
    expect(wcwidth('\u20dd')).toBe(0);
    expect(wcwidth('\u{1f3fb}')).toBe(2);
  });
});
