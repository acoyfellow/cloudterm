import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error('median requires at least one sample');
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function medianAbsoluteDeviation(samples: readonly number[]): number {
  const center = median(samples);
  return median(samples.map((sample) => Math.abs(sample - center)));
}

export function speedup(base: number, head: number): number {
  return ((base - head) / base) * 100;
}

type WorkloadName = 'sgr-tokens' | 'scroll-flood' | 'full-redraw';

type Options = {
  baseRef: string;
  rounds: number;
  minimumSpeedup: number;
  requiredWorkloads: Set<WorkloadName>;
};

const workloadNames: WorkloadName[] = ['sgr-tokens', 'scroll-flood', 'full-redraw'];
const defaultRequiredWorkloads: WorkloadName[] = ['scroll-flood', 'full-redraw'];

function parseOptions(args: string[]): Options {
  const [baseRef, ...flags] = args;
  if (!baseRef || baseRef.startsWith('--')) throw new Error('usage: bun test/bench-compare.ts <base-ref> [--rounds N] [--min pct] [--require names]');
  let rounds = 9;
  let minimumSpeedup = 30;
  let requiredWorkloads = new Set<WorkloadName>(defaultRequiredWorkloads);

  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === '--rounds') rounds = Number(value);
    else if (flag === '--min') minimumSpeedup = Number(value);
    else if (flag === '--require') {
      const names = value.split(',').filter(Boolean);
      if (names.some((name) => !workloadNames.includes(name as WorkloadName))) {
        throw new Error(`unknown workload in --require: ${value}`);
      }
      requiredWorkloads = new Set(names as WorkloadName[]);
    } else throw new Error(`unknown option: ${flag}`);
  }

  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');
  if (!Number.isFinite(minimumSpeedup)) throw new Error('--min must be a number');
  return { baseRef, rounds, minimumSpeedup, requiredWorkloads };
}

function runnerSource(): string {
  return `import { pathToFileURL } from 'node:url';
const [directory, workload] = process.argv.slice(2);
const { createHeadless } = await import(pathToFileURL(directory + '/src/headless.ts').href);
const cols = 120;
const rows = 40;
const maxScrollback = 10_000;
const inputs = {
  'sgr-tokens': '\\x1b[32mfoo\\x1b[0m '.repeat(10_000),
  'scroll-flood': ('x'.repeat(100) + '\\r\\n').repeat(50_000),
  'full-redraw': ('\\x1b[H' + ('\\x1b[32m' + 'x'.repeat(cols) + '\\x1b[0m\\r\\n').repeat(rows)).repeat(2_000),
};
const input = inputs[workload];
if (!input) throw new Error('unknown workload: ' + workload);
function run() {
  const terminal = createHeadless(cols, rows, { maxScrollback });
  terminal.feedString(input);
}
run();
run();
const started = performance.now();
run();
console.log((performance.now() - started).toString());
`;
}

function exportBaseSource(baseRef: string, directory: string): void {
  execFileSync('sh', ['-c', 'git archive "$1" src | tar -x -C "$2"', 'sh', baseRef, directory], {
    stdio: 'inherit',
  });
}

function baseSupportsOptions(directory: string): boolean {
  return readFileSync(join(directory, 'src', 'headless.ts'), 'utf8').includes('maxScrollback');
}

function sample(runner: string, directory: string, workload: WorkloadName): number {
  const output = execFileSync('bun', [runner, directory, workload], { encoding: 'utf8' }).trim();
  const duration = Number(output);
  if (!Number.isFinite(duration)) throw new Error(`runner returned an invalid duration: ${output}`);
  return duration;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'cloudterm-bench-'));
  const baseDirectory = join(temporaryRoot, 'base');
  const headDirectory = join(temporaryRoot, 'head');
  const runner = join(temporaryRoot, 'runner.ts');

  try {
    mkdirSync(baseDirectory);
    exportBaseSource(options.baseRef, baseDirectory);
    if (!baseSupportsOptions(baseDirectory)) throw new Error('base ref does not support createHeadless options');
    mkdirSync(headDirectory);
    execFileSync('cp', ['-R', 'src', headDirectory]);
    writeFileSync(runner, runnerSource());

    const samples = new Map<WorkloadName, { base: number[]; head: number[] }>();
    for (const workload of workloadNames) samples.set(workload, { base: [], head: [] });

    for (let round = 0; round < options.rounds; round += 1) {
      for (const workload of workloadNames) {
        const workloadSamples = samples.get(workload)!;
        workloadSamples.base.push(sample(runner, baseDirectory, workload));
        workloadSamples.head.push(sample(runner, headDirectory, workload));
        workloadSamples.head.push(sample(runner, headDirectory, workload));
        workloadSamples.base.push(sample(runner, baseDirectory, workload));
      }
    }

    let passed = true;
    for (const workload of workloadNames) {
      const workloadSamples = samples.get(workload)!;
      const base = median(workloadSamples.base);
      const head = median(workloadSamples.head);
      const change = speedup(base, head);
      const baseNoise = (medianAbsoluteDeviation(workloadSamples.base) / base) * 100;
      const headNoise = (medianAbsoluteDeviation(workloadSamples.head) / head) * 100;
      console.log(`${workload} base=${base.toFixed(1)}ms head=${head.toFixed(1)}ms speedup=${formatPercent(change)} noise=${formatPercent(baseNoise)}/${formatPercent(headNoise)}`);
      if (options.requiredWorkloads.has(workload) && change < options.minimumSpeedup) passed = false;
    }
    if (!passed) process.exitCode = 1;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
