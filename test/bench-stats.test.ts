import { describe, expect, test } from 'bun:test';
import { median, medianAbsoluteDeviation, speedup } from './bench-compare.js';

describe('benchmark statistics', () => {
  test('calculates the median for odd and even sample counts without mutation', () => {
    const samples = [9, 1, 5, 3];
    expect(median(samples)).toBe(4);
    expect(samples).toEqual([9, 1, 5, 3]);
    expect(median([9, 1, 5])).toBe(5);
  });

  test('calculates median absolute deviation', () => {
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 100])).toBe(1);
  });

  test('calculates positive and negative speedup percentages', () => {
    expect(speedup(100, 75)).toBe(25);
    expect(speedup(100, 125)).toBe(-25);
  });
});
