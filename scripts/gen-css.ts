import { readFile, writeFile } from 'node:fs/promises';

export function minifyCss(css: string): string {
  const commentPattern = new RegExp('/' + '\\*' + '[\\s\\S]*?' + '\\*' + '/', 'g');
  const whitespacePattern = new RegExp('\\s+', 'g');
  const punctuationWhitespacePattern = new RegExp('\\s*([{}:;,])\\s*', 'g');
  const fractionalZeroPattern = new RegExp('(^|[\\s:,(])0\\.(\\d+)', 'g');
  const trailingSemicolonPattern = new RegExp(';}','g');
  return css
    .replace(commentPattern, '')
    .replace(whitespacePattern, ' ')
    .replace(punctuationWhitespacePattern, '$1')
    .replace(fractionalZeroPattern, '$1.$2')
    .replace(trailingSemicolonPattern, '}')
    .trim();
}

export async function generateCss(): Promise<void> {
  const stylesheet = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const output = `export const BASE_CSS = ${JSON.stringify(minifyCss(stylesheet))};\n`;
  await writeFile(new URL('../src/base-css.ts', import.meta.url), output);
}

if (import.meta.main) await generateCss();
