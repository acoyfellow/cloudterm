import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { BASE_CSS } from './base-css.js';
import { minifyCss } from '../scripts/gen-css.js';

describe('base CSS', () => {
  test('matches the minified stylesheet', async () => {
    const stylesheet = await readFile(new URL('./style.css', import.meta.url), 'utf8');
    expect(BASE_CSS).toBe(minifyCss(stylesheet));
  });

  test('minifies comments and whitespace', () => {
    expect(minifyCss('/* note */ .example { color: red; padding: 0; }')).toBe(
      '.example{color:red;padding:0}',
    );
  });

  test('defines renderer and input classes', async () => {
    const stylesheet = await readFile(new URL('./style.css', import.meta.url), 'utf8');
    const sourceFiles = ['renderer.ts', 'input.ts'];
    const classes = new Set<string>();

    for (const sourceFile of sourceFiles) {
      const source = await readFile(new URL(`./${sourceFile}`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/cloudterm-[a-z-]+/g)) classes.add(match[0]);
    }

    for (const className of classes) {
      expect(stylesheet).toContain(`.${className}`);
    }
  });
});
