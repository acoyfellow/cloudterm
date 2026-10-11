import { createHeadless } from '../src/headless.js';

type Workload = {
  name: string;
  input: string;
};

const cols = 120;
const rows = 40;
const maxScrollback = 10_000;
const sgrToken = '\x1b[32mfoo\x1b[0m ';
const plainLine = `${'x'.repeat(100)}\r\n`;
const repaintRow = `\x1b[32m${'x'.repeat(cols)}\x1b[0m\r\n`;

const workloads: Workload[] = [
  { name: 'sgr-tokens', input: sgrToken.repeat(10_000) },
  { name: 'scroll-flood', input: plainLine.repeat(50_000) },
  { name: 'full-redraw', input: `${'\x1b[H'}${repaintRow.repeat(rows)}`.repeat(2_000) },
];

function run(input: string): void {
  const terminal = createHeadless(cols, rows, { maxScrollback });
  terminal.feedString(input);
}

function percentile(samples: number[], fraction: number): number {
  const index = Math.ceil(samples.length * fraction) - 1;
  return samples[index]!;
}

function benchmark(workload: Workload): void {
  for (let i = 0; i < 3; i++) run(workload.input);
  const samples: number[] = [];
  for (let i = 0; i < 15; i++) {
    const started = performance.now();
    run(workload.input);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  console.log(
    `bench ${workload.name} median=${percentile(samples, 0.5).toFixed(2)}ms p90=${percentile(samples, 0.9).toFixed(2)}ms`,
  );
}

function scrollFloodHeapMB(input: string): number {
  const terminal = createHeadless(cols, rows, { maxScrollback });
  terminal.feedString(input);
  const runtime = globalThis as typeof globalThis & {
    Bun?: { gc: (full: boolean) => void };
    gc?: () => void;
    process: { memoryUsage: () => { heapUsed: number } };
  };
  if (runtime.Bun) runtime.Bun.gc(true);
  else runtime.gc?.();
  return runtime.process.memoryUsage().heapUsed / (1024 * 1024) + terminal.grid.scrollback.length * 0;
}

for (const workload of workloads) {
  benchmark(workload);
  if (workload.name === 'scroll-flood') {
    console.log(`bench scroll-flood heapMB=${scrollFloodHeapMB(workload.input).toFixed(2)}`);
  }
}
