import { describe, test, expect } from 'bun:test';
import { keyToBytes, keyToPrediction, pasteToBytes, type KeyLike } from './input.js';

// Helper: build a KeyLike fixture. Pass key + keyCode + optional modifiers.
// Defaults match what a real KeyboardEvent has for unset properties.
function k(partial: Partial<KeyLike> & { keyCode: number }): KeyLike {
  return {
    key: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    code: '',
    type: 'keydown',
    ...partial,
  };
}

function bytesToStr(b: Uint8Array | null): string | null {
  if (!b) return null;
  return new TextDecoder().decode(b);
}

// xterm.js evaluates by keyCode. These tests pin the byte output for every
// key combination that zsh / bash / readline / vim / less care about.
// Source of truth: xterm.js v6.0.0 Keyboard.ts.

describe('keyToBytes — named keys', () => {
  test('Enter (13) → CR', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Enter', keyCode: 13 }), false))).toBe('\r');
  });

  test('Alt+Enter → ESC CR', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Enter', keyCode: 13, altKey: true }), false))).toBe('\x1b\r');
  });

  test('Backspace (8) → DEL', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Backspace', keyCode: 8 }), false))).toBe('\x7f');
  });

  test('Ctrl+Backspace → BS (^H)', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Backspace', keyCode: 8, ctrlKey: true }), false))).toBe('\b');
  });

  test('Alt+Backspace → ESC DEL (word-erase in bash)', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Backspace', keyCode: 8, altKey: true }), false))).toBe('\x1b\x7f');
  });

  test('Tab (9) → HT', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Tab', keyCode: 9 }), false))).toBe('\t');
  });

  test('Shift+Tab → CSI Z', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Tab', keyCode: 9, shiftKey: true }), false))).toBe('\x1b[Z');
  });

  test('Escape (27) → ESC', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Escape', keyCode: 27 }), false))).toBe('\x1b');
  });

  test('Alt+Escape → ESC ESC', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'Escape', keyCode: 27, altKey: true }), false))).toBe('\x1b\x1b');
  });
});

describe('keyToBytes — arrow keys', () => {
  test('plain arrows emit CSI A/B/C/D', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 37 }), false))).toBe('\x1b[D');
    expect(bytesToStr(keyToBytes(k({ keyCode: 38 }), false))).toBe('\x1b[A');
    expect(bytesToStr(keyToBytes(k({ keyCode: 39 }), false))).toBe('\x1b[C');
    expect(bytesToStr(keyToBytes(k({ keyCode: 40 }), false))).toBe('\x1b[B');
  });

  test('Shift+arrow → CSI 1;2 direction (selection-extend)', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 37, shiftKey: true }), false))).toBe('\x1b[1;2D');
    expect(bytesToStr(keyToBytes(k({ keyCode: 39, shiftKey: true }), false))).toBe('\x1b[1;2C');
  });

  test('Alt+arrow → CSI 1;3 direction', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 37, altKey: true }), false))).toBe('\x1b[1;3D');
    expect(bytesToStr(keyToBytes(k({ keyCode: 39, altKey: true }), false))).toBe('\x1b[1;3C');
  });

  test('Ctrl+arrow → CSI 1;5 direction (word-jump in zsh/bash)', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 37, ctrlKey: true }), false))).toBe('\x1b[1;5D');
    expect(bytesToStr(keyToBytes(k({ keyCode: 39, ctrlKey: true }), false))).toBe('\x1b[1;5C');
  });

  test('Ctrl+Shift+arrow → CSI 1;6 direction', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 39, ctrlKey: true, shiftKey: true }), false))).toBe('\x1b[1;6C');
  });

  test('Meta (Cmd) + arrow returns null on non-Mac (xterm treats as OS shortcut)', () => {
    expect(keyToBytes(k({ keyCode: 37, metaKey: true }), false)).toBeNull();
    expect(keyToBytes(k({ keyCode: 39, metaKey: true }), false)).toBeNull();
  });
});

describe('keyToBytes — arrow keys in application cursor mode (DECCKM)', () => {
  test('plain arrows emit ESC O A/B/C/D when app cursor mode is on', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 37 }), true))).toBe('\x1bOD');
    expect(bytesToStr(keyToBytes(k({ keyCode: 38 }), true))).toBe('\x1bOA');
    expect(bytesToStr(keyToBytes(k({ keyCode: 39 }), true))).toBe('\x1bOC');
    expect(bytesToStr(keyToBytes(k({ keyCode: 40 }), true))).toBe('\x1bOB');
  });

  test('Home / End emit ESC O H / ESC O F in app cursor mode', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 36 }), true))).toBe('\x1bOH');
    expect(bytesToStr(keyToBytes(k({ keyCode: 35 }), true))).toBe('\x1bOF');
  });

  test('modifier + arrow still uses CSI modifier form in app mode', () => {
    // xterm spec: DECCKM only affects plain arrows. Any modifier combo reverts
    // to the CSI 1;<mod> <dir> form regardless of app cursor mode. This keeps
    // vim's <C-Left> etc. working when the shell has set ?1h.
    expect(bytesToStr(keyToBytes(k({ keyCode: 37, shiftKey: true }), true))).toBe('\x1b[1;2D');
    expect(bytesToStr(keyToBytes(k({ keyCode: 39, altKey: true }), true))).toBe('\x1b[1;3C');
    expect(bytesToStr(keyToBytes(k({ keyCode: 37, ctrlKey: true }), true))).toBe('\x1b[1;5D');
    expect(bytesToStr(keyToBytes(k({ keyCode: 39, ctrlKey: true, shiftKey: true }), true))).toBe(
      '\x1b[1;6C',
    );
  });

  test('modifier + Home/End still uses CSI modifier form in app mode', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 36, ctrlKey: true }), true))).toBe('\x1b[1;5H');
    expect(bytesToStr(keyToBytes(k({ keyCode: 35, ctrlKey: true }), true))).toBe('\x1b[1;5F');
  });
});

describe('keyToBytes — navigation keys', () => {
  test('Home (36), End (35)', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 36 }), false))).toBe('\x1b[H');
    expect(bytesToStr(keyToBytes(k({ keyCode: 35 }), false))).toBe('\x1b[F');
  });

  test('Ctrl+Home / Ctrl+End → with modifier', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 36, ctrlKey: true }), false))).toBe('\x1b[1;5H');
    expect(bytesToStr(keyToBytes(k({ keyCode: 35, ctrlKey: true }), false))).toBe('\x1b[1;5F');
  });

  test('PageUp (33), PageDown (34)', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 33 }), false))).toBe('\x1b[5~');
    expect(bytesToStr(keyToBytes(k({ keyCode: 34 }), false))).toBe('\x1b[6~');
  });

  test('Shift+PageUp / Shift+PageDown → consumed by terminal scroll (type != SEND_KEY)', () => {
    // xterm.js returns PAGE_UP / PAGE_DOWN for these; cloudterm treats as null
    // so the browser can scroll naturally.
    expect(keyToBytes(k({ keyCode: 33, shiftKey: true }), false)).toBeNull();
    expect(keyToBytes(k({ keyCode: 34, shiftKey: true }), false)).toBeNull();
  });

  test('Insert (45), Delete (46)', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 45 }), false))).toBe('\x1b[2~');
    expect(bytesToStr(keyToBytes(k({ keyCode: 46 }), false))).toBe('\x1b[3~');
  });

  test('Shift+Insert → null (browser paste)', () => {
    expect(keyToBytes(k({ keyCode: 45, shiftKey: true }), false)).toBeNull();
  });

  test('Ctrl+Delete → CSI 3;5~ (word-delete in zsh)', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 46, ctrlKey: true }), false))).toBe('\x1b[3;5~');
  });
});

describe('keyToBytes — function keys', () => {
  test('F1-F4 plain → SS3 P/Q/R/S', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 112 }), false))).toBe('\x1bOP');
    expect(bytesToStr(keyToBytes(k({ keyCode: 113 }), false))).toBe('\x1bOQ');
    expect(bytesToStr(keyToBytes(k({ keyCode: 114 }), false))).toBe('\x1bOR');
    expect(bytesToStr(keyToBytes(k({ keyCode: 115 }), false))).toBe('\x1bOS');
  });

  test('F5-F12 plain → CSI n~', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 116 }), false))).toBe('\x1b[15~');
    expect(bytesToStr(keyToBytes(k({ keyCode: 117 }), false))).toBe('\x1b[17~');
    expect(bytesToStr(keyToBytes(k({ keyCode: 118 }), false))).toBe('\x1b[18~');
    expect(bytesToStr(keyToBytes(k({ keyCode: 119 }), false))).toBe('\x1b[19~');
    expect(bytesToStr(keyToBytes(k({ keyCode: 120 }), false))).toBe('\x1b[20~');
    expect(bytesToStr(keyToBytes(k({ keyCode: 121 }), false))).toBe('\x1b[21~');
    expect(bytesToStr(keyToBytes(k({ keyCode: 122 }), false))).toBe('\x1b[23~');
    expect(bytesToStr(keyToBytes(k({ keyCode: 123 }), false))).toBe('\x1b[24~');
  });

  test('Shift+F1 → CSI 1;2P', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 112, shiftKey: true }), false))).toBe('\x1b[1;2P');
  });

  test('Ctrl+F5 → CSI 15;5~', () => {
    expect(bytesToStr(keyToBytes(k({ keyCode: 116, ctrlKey: true }), false))).toBe('\x1b[15;5~');
  });
});

describe('keyToBytes — ctrl + letter (readline/zsh)', () => {
  test('Ctrl+A (1) → SOH', () => {
    expect(keyToBytes(k({ key: 'a', keyCode: 65, ctrlKey: true }), false)).toEqual(new Uint8Array([0x01]));
  });

  test('Ctrl+C → ETX (SIGINT)', () => {
    expect(keyToBytes(k({ key: 'c', keyCode: 67, ctrlKey: true }), false)).toEqual(new Uint8Array([0x03]));
  });

  test('Ctrl+D → EOT (EOF)', () => {
    expect(keyToBytes(k({ key: 'd', keyCode: 68, ctrlKey: true }), false)).toEqual(new Uint8Array([0x04]));
  });

  test('Ctrl+E → ENQ (end-of-line)', () => {
    expect(keyToBytes(k({ key: 'e', keyCode: 69, ctrlKey: true }), false)).toEqual(new Uint8Array([0x05]));
  });

  test('Ctrl+L → FF (clear screen)', () => {
    expect(keyToBytes(k({ key: 'l', keyCode: 76, ctrlKey: true }), false)).toEqual(new Uint8Array([0x0c]));
  });

  test('Ctrl+R → DC2 (reverse-i-search)', () => {
    expect(keyToBytes(k({ key: 'r', keyCode: 82, ctrlKey: true }), false)).toEqual(new Uint8Array([0x12]));
  });

  test('Ctrl+U → NAK (kill line)', () => {
    expect(keyToBytes(k({ key: 'u', keyCode: 85, ctrlKey: true }), false)).toEqual(new Uint8Array([0x15]));
  });

  test('Ctrl+W → ETB (word erase)', () => {
    expect(keyToBytes(k({ key: 'w', keyCode: 87, ctrlKey: true }), false)).toEqual(new Uint8Array([0x17]));
  });

  test('Ctrl+Z → SUB (SIGTSTP)', () => {
    expect(keyToBytes(k({ key: 'z', keyCode: 90, ctrlKey: true }), false)).toEqual(new Uint8Array([0x1a]));
  });

  test('Ctrl+[ → ESC', () => {
    expect(keyToBytes(k({ key: '[', keyCode: 219, ctrlKey: true }), false)).toEqual(new Uint8Array([0x1b]));
  });

  test('Ctrl+\\ → FS', () => {
    expect(keyToBytes(k({ key: '\\', keyCode: 220, ctrlKey: true }), false)).toEqual(new Uint8Array([0x1c]));
  });

  test('Ctrl+] → GS', () => {
    expect(keyToBytes(k({ key: ']', keyCode: 221, ctrlKey: true }), false)).toEqual(new Uint8Array([0x1d]));
  });

  test('Ctrl+Space → NUL', () => {
    expect(keyToBytes(k({ key: ' ', keyCode: 32, ctrlKey: true }), false)).toEqual(new Uint8Array([0x00]));
  });
});

describe('keyToBytes — alt + printable (meta word jumps in zsh/bash)', () => {
  test('Alt+B → ESC b (word-back in readline)', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'b', keyCode: 66, altKey: true }), false))).toBe('\x1bb');
  });

  test('Alt+F → ESC f (word-forward in readline)', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'f', keyCode: 70, altKey: true }), false))).toBe('\x1bf');
  });

  test('Alt+. → ESC . (yank last argument)', () => {
    expect(bytesToStr(keyToBytes(k({ key: '.', keyCode: 190, altKey: true }), false))).toBe('\x1b.');
  });

  test('Alt+Shift+B → ESC B (uppercase)', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'B', keyCode: 66, altKey: true, shiftKey: true }), false))).toBe('\x1bB');
  });
});

describe('keyToBytes — printable characters', () => {
  test('plain letter a → literal "a"', () => {
    // xterm.js emits plain keys. Our 'input' event handler normally clears
    // the textarea before this, but when both fire, xterm wins first.
    expect(bytesToStr(keyToBytes(k({ key: 'a', keyCode: 65 }), false))).toBe('a');
  });

  test('Shift+a → "A"', () => {
    expect(bytesToStr(keyToBytes(k({ key: 'A', keyCode: 65, shiftKey: true }), false))).toBe('A');
  });

  test('digit → literal', () => {
    expect(bytesToStr(keyToBytes(k({ key: '5', keyCode: 53 }), false))).toBe('5');
  });

  test('punctuation → literal', () => {
    expect(bytesToStr(keyToBytes(k({ key: '.', keyCode: 190 }), false))).toBe('.');
  });

  test('modifier-only keys return null (key.length != 1)', () => {
    expect(keyToBytes(k({ key: 'Shift', keyCode: 16 }), false)).toBeNull();
    expect(keyToBytes(k({ key: 'Control', keyCode: 17 }), false)).toBeNull();
    expect(keyToBytes(k({ key: 'Alt', keyCode: 18 }), false)).toBeNull();
    expect(keyToBytes(k({ key: 'Meta', keyCode: 91 }), false)).toBeNull();
  });
});

describe('keyToBytes — macOS shortcuts', () => {
  test('Cmd+A on Mac → null (SELECT_ALL handled by browser)', () => {
    // SELECT_ALL result type is not SEND_KEY, so we return null.
    // Browser native select-all fires.
    expect(keyToBytes(k({ key: 'a', keyCode: 65, metaKey: true }), false)).toBeNull();
  });

  test('Cmd+C → null (browser copy)', () => {
    expect(keyToBytes(k({ key: 'c', keyCode: 67, metaKey: true }), false)).toBeNull();
  });

  test('Cmd+V → null (paste event handles it)', () => {
    expect(keyToBytes(k({ key: 'v', keyCode: 86, metaKey: true }), false)).toBeNull();
  });
});

// keyToPrediction decides whether a keydown should also fire the speculative
// local-echo callback. Conservative by design: arrow keys, control combos,
// and function keys must NOT fire, because guessing wrong is worse than not
// guessing. Only plain printable chars and Backspace qualify.

describe('keyToPrediction — printable chars fire', () => {
  test("plain 'a' fires { kind: 'char', ch: 'a' }", () => {
    expect(keyToPrediction(k({ key: 'a', keyCode: 65 }))).toEqual({
      kind: 'char',
      ch: 'a',
    });
  });

  test("Shift+a fires { kind: 'char', ch: 'A' } (key already reflects shift)", () => {
    expect(keyToPrediction(k({ key: 'A', keyCode: 65, shiftKey: true }))).toEqual({
      kind: 'char',
      ch: 'A',
    });
  });

  test("digit fires char", () => {
    expect(keyToPrediction(k({ key: '5', keyCode: 53 }))).toEqual({
      kind: 'char',
      ch: '5',
    });
  });

  test("punctuation fires char", () => {
    expect(keyToPrediction(k({ key: '.', keyCode: 190 }))).toEqual({
      kind: 'char',
      ch: '.',
    });
    expect(keyToPrediction(k({ key: ' ', keyCode: 32 }))).toEqual({
      kind: 'char',
      ch: ' ',
    });
  });
});

describe('keyToPrediction — Backspace fires', () => {
  test('Backspace fires { kind: "backspace" }', () => {
    expect(keyToPrediction(k({ key: 'Backspace', keyCode: 8 }))).toEqual({
      kind: 'backspace',
    });
  });
});

describe('keyToPrediction — modifier combos do not fire', () => {
  test('Ctrl+C does NOT fire', () => {
    expect(keyToPrediction(k({ key: 'c', keyCode: 67, ctrlKey: true }))).toBeNull();
  });

  test('Ctrl+L does NOT fire', () => {
    expect(keyToPrediction(k({ key: 'l', keyCode: 76, ctrlKey: true }))).toBeNull();
  });

  test('Cmd+A does NOT fire', () => {
    expect(keyToPrediction(k({ key: 'a', keyCode: 65, metaKey: true }))).toBeNull();
  });

  test('Cmd+V does NOT fire (paste path handles it)', () => {
    expect(keyToPrediction(k({ key: 'v', keyCode: 86, metaKey: true }))).toBeNull();
  });

  test('Alt+B does NOT fire (readline word-back is an escape sequence, not an echo)', () => {
    expect(keyToPrediction(k({ key: 'b', keyCode: 66, altKey: true }))).toBeNull();
  });

  test('Ctrl+Backspace does NOT fire (it sends ^H, which is not a visible echo at cursor)', () => {
    expect(
      keyToPrediction(k({ key: 'Backspace', keyCode: 8, ctrlKey: true })),
    ).toBeNull();
  });
});

describe('keyToPrediction — navigation and special keys do not fire', () => {
  test('arrow keys do NOT fire', () => {
    expect(keyToPrediction(k({ key: 'ArrowLeft', keyCode: 37 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'ArrowUp', keyCode: 38 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'ArrowRight', keyCode: 39 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'ArrowDown', keyCode: 40 }))).toBeNull();
  });

  test('Enter does NOT fire (the server decides how the prompt redraws)', () => {
    expect(keyToPrediction(k({ key: 'Enter', keyCode: 13 }))).toBeNull();
  });

  test('Tab does NOT fire (completion output is unpredictable)', () => {
    expect(keyToPrediction(k({ key: 'Tab', keyCode: 9 }))).toBeNull();
  });

  test('Escape does NOT fire', () => {
    expect(keyToPrediction(k({ key: 'Escape', keyCode: 27 }))).toBeNull();
  });

  test('F-keys do NOT fire', () => {
    expect(keyToPrediction(k({ key: 'F1', keyCode: 112 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'F5', keyCode: 116 }))).toBeNull();
  });

  test('Home/End/PageUp/PageDown/Insert/Delete do NOT fire', () => {
    expect(keyToPrediction(k({ key: 'Home', keyCode: 36 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'End', keyCode: 35 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'PageUp', keyCode: 33 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'PageDown', keyCode: 34 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'Insert', keyCode: 45 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'Delete', keyCode: 46 }))).toBeNull();
  });

  test('modifier-only keys do NOT fire', () => {
    expect(keyToPrediction(k({ key: 'Shift', keyCode: 16 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'Control', keyCode: 17 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'Alt', keyCode: 18 }))).toBeNull();
    expect(keyToPrediction(k({ key: 'Meta', keyCode: 91 }))).toBeNull();
  });
});
