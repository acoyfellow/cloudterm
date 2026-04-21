// Orchestrator. Runs every scenario, prints a terse live summary, writes
// test/REPORT.md with full snapshot dumps for human review.

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScenario, type ScenarioResult, type Snapshot } from './pty-smoke.js';
import { scenario as basic } from './scenarios/basic.js';
import { scenario as vim } from './scenarios/vim.js';
import { scenario as less } from './scenarios/less.js';
import { scenario as htop } from './scenarios/htop.js';
import { scenario as tmux } from './scenarios/tmux.js';
import { scenario as heavyOutput } from './scenarios/heavy-output.js';

const scenarios = [basic, vim, less, heavyOutput, htop, tmux];

function statusTag(r: ScenarioResult): string {
  if (r.skipped) return 'SKIP';
  if (r.passed) return 'PASS';
  return 'FAIL';
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function snapshotMarkdown(s: Snapshot): string {
  const lines: string[] = [];
  lines.push(`### snapshot: \`${s.label}\``);
  lines.push('');
  lines.push(
    `- cursor: row=${s.cursor.row}, col=${s.cursor.col}` +
      ` (grid is ${s.rows}x${s.cols})`,
  );
  lines.push(`- altScreen: \`${s.altScreen}\``);
  lines.push(`- scrollback rows: ${s.scrollbackLen}`);
  lines.push('');
  lines.push('```');
  // Mark cursor position inline using a caret on a dedicated line so the
  // rendered screen stays faithful. Keep this as a straight dump.
  lines.push(s.screen);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function resultMarkdown(r: ScenarioResult): string {
  const out: string[] = [];
  out.push(`## ${r.name} — ${statusTag(r)} (${fmtMs(r.durationMs)})`);
  out.push('');
  if (r.skipped) {
    out.push(`_skipped: ${r.skipReason}_`);
    out.push('');
    return out.join('\n');
  }
  out.push(`- bytes received from PTY: ${r.bytesReceived}`);
  out.push(`- snapshots: ${r.snapshots.length}`);
  out.push(`- steps: ${r.steps.length}`);
  if (r.error) {
    out.push('');
    out.push(`**error:** \`${r.error}\``);
  }
  out.push('');
  out.push('<details><summary>step trace</summary>');
  out.push('');
  out.push('| # | type | label | ms | note |');
  out.push('|---|------|-------|----|------|');
  r.steps.forEach((s, i) => {
    const note = (s.note ?? '').replace(/\|/g, '\\|');
    out.push(`| ${i} | ${s.type} | ${s.label ?? ''} | ${s.durationMs} | ${note} |`);
  });
  out.push('');
  out.push('</details>');
  out.push('');
  for (const snap of r.snapshots) out.push(snapshotMarkdown(snap));
  if (r.finalScreen !== undefined) {
    out.push('### final state (after scenario cleanup)');
    out.push('');
    out.push(
      `- cursor: row=${r.finalCursor?.row ?? '?'}, col=${r.finalCursor?.col ?? '?'}` +
        ` · altScreen: \`${r.finalAltScreen}\``,
    );
    out.push('');
    out.push('```');
    out.push(r.finalScreen);
    out.push('```');
    out.push('');
  }
  return out.join('\n');
}

async function main() {
  const results: ScenarioResult[] = [];
  console.log('cloudterm smoke harness');
  console.log(`node ${process.version} · ${process.platform}/${process.arch}`);
  console.log('');

  for (const s of scenarios) {
    const line = `> ${s.name.padEnd(14)}`;
    process.stdout.write(line);
    const r = await runScenario(s);
    results.push(r);
    const tag = statusTag(r);
    const extra = r.skipped
      ? ` (${r.skipReason})`
      : r.error
      ? ` (${r.error})`
      : ` · ${r.snapshots.length} snapshots · ${r.bytesReceived}B`;
    process.stdout.write(`  ${tag} ${fmtMs(r.durationMs)}${extra}\n`);
  }

  // Summary counters
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const r of results) {
    if (r.skipped) counts.skip += 1;
    else if (r.passed) counts.pass += 1;
    else counts.fail += 1;
  }

  console.log('');
  console.log(
    `summary: ${counts.pass} pass · ${counts.fail} fail · ${counts.skip} skip`,
  );

  // Build REPORT.md.
  const md: string[] = [];
  md.push('# cloudterm smoke report');
  md.push('');
  md.push(`Generated ${new Date().toISOString()} on node ${process.version}.`);
  md.push('');
  md.push(
    `**${counts.pass} pass · ${counts.fail} fail · ${counts.skip} skip**`,
  );
  md.push('');
  md.push('| scenario | status | duration | snapshots | bytes |');
  md.push('|----------|--------|----------|-----------|-------|');
  for (const r of results) {
    md.push(
      `| ${r.name} | ${statusTag(r)} | ${fmtMs(r.durationMs)} | ` +
        `${r.snapshots.length} | ${r.bytesReceived} |`,
    );
  }
  md.push('');
  md.push('## how to read this');
  md.push('');
  md.push(
    '- Each snapshot is the raw grid dump at a labeled point in the scenario.',
  );
  md.push(
    '- `altScreen: true` means the grid reports the alternate buffer is active.',
  );
  md.push(
    '  If the field reads `false` during `vim`/`less`/`htop`, alt-screen routing',
  );
  md.push('  is not wired up yet.');
  md.push('- Cursor row/col are 0-indexed relative to the active screen.');
  md.push(
    '- `main-before-*` vs `main-after-*` snapshots diff the main buffer across',
  );
  md.push(
    '  an alt-screen excursion. If they differ unexpectedly, the main buffer was',
  );
  md.push('  not preserved.');
  md.push('');

  for (const r of results) md.push(resultMarkdown(r));

  const here = dirname(fileURLToPath(import.meta.url));
  const reportPath = join(here, 'REPORT.md');
  await writeFile(reportPath, md.join('\n'), 'utf8');
  console.log(`report written: ${reportPath}`);

  // Non-zero exit if any scenario failed (not skipped). Jordan can override
  // in CI if desired, but locally this matches the convention of other test
  // commands.
  process.exit(counts.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('runner crashed:', err);
  process.exit(2);
});
