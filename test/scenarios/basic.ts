// Basic smoke: can cloudterm's parser keep up with a normal zsh session.
// Uses PS1=">>> " to make prompt detection deterministic across user configs.

import type { Scenario } from "../pty-smoke.js";

const PROMPT = ">>> ";

export const scenario: Scenario = {
  name: "basic",
  shell: "/bin/zsh",
  cols: 80,
  rows: 24,
  timeoutMs: 10_000,
  script: [
    // Force a boring prompt so regex matching is not fighting oh-my-zsh.
    { type: "input", bytes: `export PS1='${PROMPT}' PS2='... '; clear\r` },
    { type: "waitFor", regex: new RegExp(PROMPT), label: "initial-prompt" },
    { type: "snapshot", label: "after-clear" },

    { type: "input", bytes: "echo hello\r" },
    { type: "waitFor", regex: /hello/, label: "echo-output" },
    { type: "snapshot", label: "after-echo" },

    { type: "input", bytes: "pwd\r" },
    { type: "waitFor", regex: new RegExp("/"), label: "pwd-output" },
    { type: "snapshot", label: "after-pwd" },

    { type: "input", bytes: 'printf "col1\\tcol2\\tcol3\\n"\r' },
    { type: "waitFor", regex: /col3/, label: "tabs" },
    {
      type: "snapshot",
      label: "after-tabs",
      expect: {
        rows: { 5: "col1    col2    col3", 6: ">>>" },
        cursor: { row: 6, col: 4 },
        inAltScreen: false,
      },
    },

    { type: "input", bytes: "clear\r" },
    { type: "wait", ms: 200 },
    {
      type: "snapshot",
      label: "after-second-clear",
      expect: {
        rows: { 0: ">>>" },
        cursor: { row: 0, col: 4 },
        inAltScreen: false,
      },
    },

    { type: "input", bytes: "exit\r" },
  ],
};
