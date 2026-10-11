import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

interface PackageManifest {
  sizeBudget: Record<string, number>;
}

const outputPath = 'dist/index.js';
const [bundle, manifestText] = await Promise.all([
  readFile(new URL(`../${outputPath}`, import.meta.url)),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);
const manifest = JSON.parse(manifestText) as PackageManifest;
const budget = manifest.sizeBudget[outputPath];

if (typeof budget !== 'number') throw new Error(`Missing size budget for ${outputPath}`);

const gzipSize = gzipSync(bundle, { level: 9 }).length;
const headroom = budget - gzipSize;
console.log(`raw: ${bundle.length} bytes`);
console.log(`gzip: ${gzipSize} bytes`);
console.log(`budget: ${budget} bytes`);
console.log(`headroom: ${headroom} bytes`);

if (gzipSize > budget) process.exit(1);
