// htop stresses alt-screen + heavy SGR + frequent redraw. Optional: only
// runs if htop is installed. Jordan's machine ships without it.

import { execSync } from "node:child_process";
import type { Scenario } from "../pty-smoke.js";

const PROMPT = ">>> ";

function hasHtop(): boolean {
  try {
    execSync("command -v htop", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const scenario: Scenario = {
  name: "htop",
  shell: "/bin/zsh",
  cols: 120,
  rows: 30,
  timeoutMs: 12_000,
  skipIf: () =>
    hasHtop() ? { skip: false } : { skip: true, reason: "htop not installed" },
  script: [
    { type: "input", bytes: `export PS1='${PROMPT}' PS2='... '; clear\r` },
    {
      type: "waitFor",
      label: "initial-prompt",
      until: { rows: { 0: ">>>" }, cursor: { row: 0, col: 4 } },
    },
    { type: "snapshot", label: "main-before-htop" },

    { type: "input", bytes: "htop\r" },
    // htop draws a header line with "CPU" labels quickly.
    {
      type: "waitFor",
      regex: /CPU|PID|htop/,
      timeoutMs: 4000,
      label: "htop-painted",
    },
    {
      type: "waitFor",
      label: "htop-alt-screen",
      until: { inAltScreen: true },
    },
    { type: "snapshot", label: "in-htop", expect: { inAltScreen: true } },

    { type: "snapshot", label: "in-htop-later", expect: { inAltScreen: true } },

    // q to quit htop.
    { type: "input", bytes: "q" },
    {
      type: "waitFor",
      regex: new RegExp(PROMPT),
      timeoutMs: 4000,
      label: "prompt-after-htop",
    },
    {
      type: "snapshot",
      label: "main-after-htop",
      expect: { rows: { 0: ">>> htop", 1: ">>>" }, inAltScreen: false },
    },

    { type: "input", bytes: "exit\r" },
  ],
};
