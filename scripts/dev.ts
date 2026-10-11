import demoPage from '../demo/index.html';

const port = Number(process.env.PORT ?? 4173);

Bun.serve({
  hostname: '0.0.0.0',
  port,
  development: { hmr: true },
  routes: { '/': demoPage },
});

console.log(`Demo server: http://localhost:${port}`);
