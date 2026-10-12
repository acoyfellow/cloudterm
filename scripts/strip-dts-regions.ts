const path = 'dist/index.d.ts';
const source = await Bun.file(path).text();
await Bun.write(path, source.split('\n').filter((line) => !/^\/\/#(end)?region\b/.test(line)).join('\n'));
