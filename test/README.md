# cloudterm smoke harness

Drives a real shell through a PTY, pipes its output through cloudterm's
parser + grid, and dumps grid state at labeled points. It's a diagnostic,
not a CI gate. Read `REPORT.md` after each run and decide by eye what's
broken.

## How to run

```sh
bun run smoke
```

Runs under node via `tsx`. Under Bun the `node-pty` native module segfaults
on spawn on this machine, so the script is node-only.

Output: terse per-scenario summary on stdout, and a fresh `test/REPORT.md`
with full step traces and snapshot dumps.

## Files

| path | role |
|------|------|
| `pty-smoke.ts` | harness: `runScenario(s) -> ScenarioResult` |
| `scenarios/basic.ts` | echo, pwd, tabs, clear |
| `scenarios/vim.ts` | alt-screen round trip via vim |
| `scenarios/less.ts` | alt-screen + pager scroll |
| `scenarios/htop.ts` | optional; skipped unless `htop` on PATH |
| `scenarios/tmux.ts` | optional; skipped unless `tmux` on PATH |
| `runner.ts` | orchestrator; writes `REPORT.md` |
| `REPORT.md` | diagnostic artifact, overwritten each run |

The harness uses `src/headless.ts` as its only entry into cloudterm. Don't
reach past that into `src/grid.ts` or `src/parser.ts` directly.

## Scenario shape

```ts
interface Scenario {
  name: string;
  shell: string;       // "/bin/zsh" or "/bin/bash"
  cols: number;
  rows: number;
  script: Step[];
  skipIf?: () => { skip: true; reason: string } | { skip: false };
  timeoutMs?: number;  // default 15000
}

type Step =
  | { type: "input",    bytes: string | Uint8Array }
  | { type: "wait",     ms: number }
  | { type: "waitFor",  regex: RegExp, timeoutMs?: number, label?: string }
  | { type: "snapshot", label: string };
```

`waitFor` polls the rendered screen every 20ms until the regex matches or
times out. `snapshot` waits 50ms to let in-flight output settle, then
captures `grid.screen` as text plus cursor and `inAltScreen` flag.

## How to interpret REPORT.md

Each scenario section has:

- **status line:** `PASS` / `FAIL` / `SKIP`, duration, byte count
- **step trace:** collapsed `<details>` block with one row per step
- **snapshots:** labeled grid dumps

For each snapshot:

- `cursor: row=N, col=N` - 0-indexed cell position inside the screen region
- `altScreen: true|false` - alt buffer active
- `scrollback rows: N` - rows pushed off the top of main
- fenced block: one row of the screen per line, trailing whitespace trimmed

### Things to look for

- **Alt-screen routing.** In `vim` and `less` scenarios, `altScreen` should
  flip `true` between enter and exit. `main-before-*` and `main-after-*`
  snapshots should show the main buffer survived the excursion.
- **Cursor drift.** After a prompt line, cursor col should match the prompt
  width. If cursor is off-by-one, likely a CUP (CSI H) or erase-in-line
  bug.
- **Stray characters in main buffer.** If `main-after-less` contains the
  character the user pressed to quit the pager (`q`), that means the
  character leaked into the main buffer instead of being consumed by the
  alt buffer. Alt-screen exit cleanup bug.
- **Prompt not visible in first snapshot.** Snapshots race the shell's
  initial paint. Rerun with a longer `wait` before the first snapshot, or
  compare against the `final state` block which reflects everything.

## Adding a scenario

1. Create `scenarios/myname.ts`:
   ```ts
   import type { Scenario } from "../pty-smoke.js";
   export const scenario: Scenario = {
     name: "myname",
     shell: "/bin/zsh",
     cols: 80,
     rows: 24,
     script: [ /* ... */ ],
   };
   ```
2. Import and add to the `scenarios` array in `runner.ts`.
3. Force a deterministic prompt first:
   ```
   { type: "input",   bytes: "export PS1='>>> '; clear\r" }
   { type: "waitFor", regex: />>> / }
   ```
   Otherwise you'll be debugging oh-my-zsh, not cloudterm.
4. Use `skipIf` for tools that might not be installed.

## Known footguns

- **node-pty `spawn-helper` perm bit.** Bun's tarball extractor drops the
  execute bit on `prebuilds/darwin-arm64/spawn-helper`. The harness repairs
  this on startup. If you see `posix_spawnp failed`, re-check that fix ran.
- **Bun + node-pty.** `bun test/runner.ts` hangs. Use `tsx` (`bun run smoke`
  already does).
- **Terminal size.** Scenarios pick `cols x rows`. Changing it changes
  every wrap point and vim's layout. Pick a size and stick with it per
  scenario.
- **Shell init files.** `/bin/zsh` reads the user's `.zshrc`. The prompt
  override at the start of each scenario is what keeps regexes working.
