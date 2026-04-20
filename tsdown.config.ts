import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  dts: true,
  clean: true,
  minify: true,
  sourcemap: false,
  external: ['@chenglou/pretext'],
  copy: [{ from: 'src/style.css', to: 'dist/style.css' }],
});
