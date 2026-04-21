// Alt-screen with pager. less uses the alt buffer and redraws on key input.
// Good stressor for erase-in-display + cursor-position combinations.

import type { Scenario } from '../pty-smoke.js';

const PROMPT = '>>> ';

export const scenario: Scenario = {
  name: 'less',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  timeoutMs: 15_000,
  script: [
    { type: 'input', bytes: `export PS1='${PROMPT}' PS2='... '; clear\r` },
    { type: 'waitFor', regex: new RegExp(PROMPT), label: 'initial-prompt' },
    { type: 'snapshot', label: 'main-before-less' },

    { type: 'input', bytes: 'less /etc/passwd\r' },
    // Wait for actual /etc/passwd content, not just the echoed command. root
    // and nobody are present on every macOS install.
    {
      type: 'waitFor',
      regex: /(root|nobody|daemon):/,
      timeoutMs: 3000,
      label: 'less-content',
    },
    { type: 'snapshot', label: 'in-less' },

    // Page forward. Space is the less pager bind.
    { type: 'input', bytes: ' ' },
    { type: 'wait', ms: 250 },
    { type: 'snapshot', label: 'in-less-scrolled' },

    { type: 'input', bytes: 'q' },
    { type: 'waitFor', regex: new RegExp(PROMPT), timeoutMs: 3000, label: 'prompt-after-less' },
    { type: 'snapshot', label: 'main-after-less' },

    { type: 'input', bytes: 'exit\r' },
  ],
};
