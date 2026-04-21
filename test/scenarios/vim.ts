// Alt-screen round trip. Open vim, inspect the alt buffer, quit, inspect
// that the main screen survived. If alt-screen support is not yet landed
// in grid.ts, this scenario will surface it: the "main-after" snapshot will
// show vim UI remnants instead of the preserved prompt.

import type { Scenario } from '../pty-smoke.js';

const PROMPT = '>>> ';
const MARKER = 'MARKER_BEFORE_VIM_42';

export const scenario: Scenario = {
  name: 'vim',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  timeoutMs: 15_000,
  script: [
    { type: 'input', bytes: `export PS1='${PROMPT}' PS2='... '; clear\r` },
    { type: 'waitFor', regex: new RegExp(PROMPT), label: 'initial-prompt' },
    { type: 'input', bytes: `echo ${MARKER}\r` },
    { type: 'waitFor', regex: new RegExp(MARKER), label: 'marker-visible' },
    { type: 'snapshot', label: 'main-before-vim' },

    // Launch vim on an empty buffer. -n disables swap files, -u NONE
    // skips user vimrc so this is reproducible.
    { type: 'input', bytes: 'vim -n -u NONE\r' },
    // Vim paints "~" on every empty line.
    { type: 'waitFor', regex: /~/, timeoutMs: 5000, label: 'vim-painted' },
    { type: 'wait', ms: 200 },
    { type: 'snapshot', label: 'alt-in-vim' },

    // Type some text in vim so we can see it in the alt screen snapshot.
    { type: 'input', bytes: 'iHELLO_FROM_VIM\x1b' },
    { type: 'waitFor', regex: /HELLO_FROM_VIM/, label: 'vim-typed' },
    { type: 'snapshot', label: 'alt-in-vim-with-text' },

    // :q! to exit without writing.
    { type: 'input', bytes: ':q!\r' },
    { type: 'waitFor', regex: new RegExp(PROMPT), timeoutMs: 5000, label: 'prompt-after-vim' },
    { type: 'snapshot', label: 'main-after-vim' },

    { type: 'input', bytes: 'exit\r' },
  ],
};
