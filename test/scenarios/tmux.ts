// tmux. Nested terminal inside our terminal. Worst-case alt-screen user:
// tmux itself manages an alt buffer and its panes redraw aggressively.

import { execSync } from 'node:child_process';
import type { Scenario } from '../pty-smoke.js';

const PROMPT = '>>> ';

function hasTmux(): boolean {
  try {
    execSync('command -v tmux', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const scenario: Scenario = {
  name: 'tmux',
  shell: '/bin/zsh',
  cols: 120,
  rows: 30,
  timeoutMs: 15_000,
  skipIf: () => (hasTmux() ? { skip: false } : { skip: true, reason: 'tmux not installed' }),
  script: [
    { type: 'input', bytes: `export PS1='${PROMPT}' PS2='... '; clear\r` },
    { type: 'waitFor', regex: new RegExp(PROMPT), label: 'initial-prompt' },
    { type: 'snapshot', label: 'main-before-tmux' },

    // -L cloudterm-smoke gives us an isolated server so we never attach to
    // a pre-existing tmux session.
    { type: 'input', bytes: 'tmux -L cloudterm-smoke new-session -s t -d\r' },
    { type: 'wait', ms: 300 },
    { type: 'input', bytes: 'tmux -L cloudterm-smoke attach -t t\r' },
    // Inside tmux the status bar at the bottom shows the session name.
    { type: 'waitFor', regex: /(\[t\]|0:zsh|\$ )/, timeoutMs: 4000, label: 'tmux-attached' },
    { type: 'wait', ms: 200 },
    { type: 'snapshot', label: 'in-tmux' },

    // Run a command inside tmux's inner shell.
    { type: 'input', bytes: 'echo tmux_inner\r' },
    { type: 'waitFor', regex: /tmux_inner/, label: 'tmux-inner-output' },
    { type: 'snapshot', label: 'in-tmux-after-command' },

    // Detach: prefix C-b then d.
    { type: 'input', bytes: '\x02d' },
    { type: 'waitFor', regex: new RegExp(PROMPT), timeoutMs: 4000, label: 'prompt-after-detach' },
    { type: 'snapshot', label: 'main-after-tmux' },

    // Clean up the tmux server so we don't leave background processes.
    { type: 'input', bytes: 'tmux -L cloudterm-smoke kill-server\r' },
    { type: 'wait', ms: 200 },
    { type: 'input', bytes: 'exit\r' },
  ],
};
