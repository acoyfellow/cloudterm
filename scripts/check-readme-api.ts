import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const readmePath = resolve(process.argv[2] ?? 'README.md');
const definitions = await readFile(resolve('dist/index.d.ts'), 'utf8');
const readme = await readFile(readmePath, 'utf8');

const interfaceNames = [...definitions.matchAll(/interface\s+(\w+)\s*\{([\s\S]*?)\n\}/g)];
const names = new Set<string>();

for (const [, interfaceName, body] of interfaceNames) {
  names.add(interfaceName);
  for (const line of body.split('\n')) {
    const member = line.trim().match(/^(?:readonly\s+)?(\w+)\??(?:\(|:)/);
    if (member) names.add(member[1]);
  }
}

for (const exported of definitions.matchAll(/export\s+\{([^}]+)\}/g)) {
  for (const item of exported[1].split(',')) {
    const name = item.trim().replace(/^type\s+/, '');
    if (name) names.add(name);
  }
}

const missing = [...names].filter((name) => !new RegExp(`\\b${name}\\b`).test(readme));

if (missing.length > 0) {
  console.error(`${readmePath} is missing API names: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`${readmePath} documents ${names.size} API names.`);
