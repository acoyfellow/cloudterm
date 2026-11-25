import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const out = join(root, 'site');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const built = await Bun.build({
  entrypoints: [join(root, 'demo/main.ts')],
  outdir: out,
  minify: true,
  target: 'browser',
  naming: 'app.js',
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

const html = readFileSync(join(root, 'demo/index.html'), 'utf8').replace(
  '<script type="module" src="./main.ts"></script>',
  '<script type="module" src="/app.js"></script>',
);
writeFileSync(join(out, 'index.html'), html);
copyFileSync(join(root, 'llms.txt'), join(out, 'llms.txt'));
console.log(`Built demo site in ${out}`);
