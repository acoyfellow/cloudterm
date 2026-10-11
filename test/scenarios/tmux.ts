// tmux. Nested terminal inside our terminal. Worst-case alt-screen user:
// tmux itself manages an alt buffer and its panes redraw aggressively.

import { execSync } from "node:child_process";
import type { Scenario } from "../pty-smoke.js";

const PROMPT = ">>> ";

function hasTmux(): boolean {
  try {
    execSync("command -v tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const scenario: Scenario = {
  name: "tmux",
  shell: "/bin/zsh",
  cols: 120,
  rows: 30,
  timeoutMs: 15_000,
  skipIf: () =>
    hasTmux() ? { skip: false } : { skip: true, reason: "tmux not installed" },
  cleanup: () => {
    try {
      execSync("tmux -L cloudterm-smoke kill-server", { stdio: "ignore" });
    } catch {}
  },
  script: [
    { type: "input", bytes: `export PS1='${PROMPT}' PS2='... '; clear\r` },
    {
      type: "waitFor",
      label: "initial-prompt",
      until: { rows: { 0: ">>>" }, cursor: { row: 0, col: 4 } },
    },
    { type: "snapshot", label: "main-before-tmux" },

    // -L cloudterm-smoke gives us an isolated server so we never attach to
    // a pre-existing tmux session.
    { type: "input", bytes: "tmux -L cloudterm-smoke new-session -s t -d\r" },
    {
      type: "waitFor",
      regex: new RegExp(PROMPT),
      label: "tmux-server-started",
    },
    { type: "input", bytes: "tmux -L cloudterm-smoke attach -t t\r" },
    {
      type: "waitFor",
      label: "tmux-attached",
      until: { rowPrefixes: { 29: " t 0:zsh*" }, inAltScreen: true },
    },
    {
      type: "snapshot",
      label: "in-tmux",
      expect: { rowPrefixes: { 29: " t 0:zsh*" }, inAltScreen: true },
    },

    // Run a command inside tmux's inner shell.
    { type: "input", bytes: "echo tmux_inner\r" },
    {
      type: "waitFor",
      label: "tmux-command-complete",
      until: { inAltScreen: true },
    },
    {
      type: "snapshot",
      label: "in-tmux-after-command",
      expect: { inAltScreen: true },
    },

    // Detach: prefix C-b then d.
    { type: "input", bytes: "\x02d" },
    {
      type: "waitFor",
      label: "tmux-detached",
      until: { inAltScreen: false },
    },
    {
      type: "snapshot",
      label: "main-after-tmux",
      expect: { inAltScreen: false },
    },

    // Clean up the tmux server so we don't leave background processes.
    { type: "input", bytes: "tmux -L cloudterm-smoke kill-server\r" },
    { type: "input", bytes: "exit\r" },
  ],
};
