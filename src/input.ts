// Hidden textarea, keyboard + paste -> bytes.
//
// The textarea overlays the full host at opacity:0. This matches xterm.js:
// clicks land on it (so focus is natural), it captures all keyboard input,
// and it is invisible. The visible terminal content sits beneath and is
// painted by the renderer.
//
// keydown runs the xterm.js `evaluateKeyboardEvent` port and emits bytes for
// named/control keys. `input` handles printable chars (and IME) as UTF-8.
// `paste` handles clipboard text as UTF-8.

import {
  evaluateKeyboardEvent,
  KeyboardResultType,
  type IKeyboardEvent,
} from './xterm-keyboard.js';

export interface InputOpts {
  onData: (bytes: Uint8Array) => void;
  // Read the current DECCKM state from the grid at each keydown. When true,
  // plain arrow keys emit `ESC O A/B/C/D`; when false, `CSI A/B/C/D`. See
  // xterm-keyboard.ts for the exact dispatch table.
  getApplicationCursorMode?: () => boolean;
  // Read the current bracketed-paste state from the grid at each paste. When
  // true, pasted text is wrapped with ESC [ 200 ~ and ESC [ 201 ~ so the
  // shell can distinguish it from typed input.
  getBracketedPasteMode?: () => boolean;
  // Speculative local-echo hook. Fires alongside onData for keys that have a
  // predictable visual effect at the cursor: printable chars and backspace.
  // Arrow keys, function keys, control combos, and modifier-only keys do not
  // fire this. Pasted text also does not fire this (too easy to be wrong).
  predict?: (event: PredictEvent) => void;
}

export type PredictEvent =
  | { kind: 'char'; ch: string }
  | { kind: 'backspace' };

// Minimal shape used by keyToBytes. Keeps the function testable without a DOM.
// Mirrors the subset of `KeyboardEvent` that xterm.js's evaluateKeyboardEvent
// reads: modifier flags plus `key`, `keyCode`, `code`, `type`.
export interface KeyLike {
  key: string;
  keyCode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code?: string;
  type?: string;
}

const ENC = new TextEncoder();

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as { platform?: string }).platform ?? '';
  if (platform) return /Mac|iPhone|iPad|iPod/.test(platform);
  const ua = navigator.userAgent ?? '';
  return /Mac|iPhone|iPad|iPod/.test(ua);
}

// Adapter around xterm.js's evaluateKeyboardEvent. Returns the bytes to send
// to the PTY, or null to let the browser handle the event (the 'input' event
// path picks up printable chars / IME composition).
//
// `applicationCursorMode` is DECCKM: when true (set by the shell via
// `CSI ?1 h`, cleared by `CSI ?1 l`), plain arrow keys emit `ESC O A/B/C/D`
// instead of `CSI A/B/C/D`. Modifier + arrow still uses the CSI form in both
// modes (xterm behavior).
// Decide if a keyboard event should fire a local-echo prediction, and what
// kind. Returns null when the event has no predictable visual effect at the
// current cursor (arrows, function keys, control combos, modifier-only,
// anything with Ctrl/Alt/Meta). Kept as a pure function so it is testable
// without a DOM: InputHandler.onKeydown calls this immediately after
// keyToBytes.
export function keyToPrediction(e: KeyLike): PredictEvent | null {
  // Any Ctrl/Meta combo bails. Alt also bails: Alt+letter is a readline
  // escape (word-jump, yank-last-arg), not a visible echo at cursor.
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Backspace') return { kind: 'backspace' };
  if (typeof e.key !== 'string' || e.key.length !== 1) return null;
  const cc = e.key.charCodeAt(0);
  if (cc < 0x20 || cc === 0x7f) return null;
  return { kind: 'char', ch: e.key };
}

// Encode pasted clipboard text into bytes to send to the PTY. When bracketed
// paste is enabled, wrap with ESC [ 200 ~ and ESC [ 201 ~ so the shell can
// distinguish paste from typed input. Strip any embedded bracketed-paste
// markers from the clipboard content first: a malicious terminal stream
// copied to the clipboard could otherwise inject an `ESC [ 201 ~` that ends
// the bracket prematurely and lets the rest run as keystrokes.
export function pasteToBytes(text: string, bracketedPasteMode: boolean): Uint8Array {
  if (!bracketedPasteMode) return ENC.encode(text);
  const safe = text.split('\x1b[200~').join('').split('\x1b[201~').join('');
  return ENC.encode('\x1b[200~' + safe + '\x1b[201~');
}

export function keyToBytes(e: KeyLike, applicationCursorMode: boolean): Uint8Array | null {
  const ev: IKeyboardEvent = {
    key: e.key,
    keyCode: e.keyCode,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
    code: e.code ?? '',
    type: e.type ?? 'keydown',
  };
  const result = evaluateKeyboardEvent(ev, applicationCursorMode, isMac(), true);
  if (result.type !== KeyboardResultType.SEND_KEY) return null;
  if (!result.key) return null;
  return ENC.encode(result.key);
}

export class InputHandler {
  ta: HTMLTextAreaElement;
  private onData: (b: Uint8Array) => void;
  private getAppCursor: () => boolean;
  private getBracketedPaste: () => boolean;
  private predict: ((e: PredictEvent) => void) | null;
  private boundKeydown = this.onKeydown.bind(this);
  private boundInput = this.onInput.bind(this);
  private boundPaste = this.onPaste.bind(this);

  constructor(parent: HTMLElement, opts: InputOpts) {
    this.onData = opts.onData;
    this.getAppCursor = opts.getApplicationCursorMode ?? (() => false);
    this.getBracketedPaste = opts.getBracketedPasteMode ?? (() => false);
    this.predict = opts.predict ?? null;
    this.ta = document.createElement('textarea');
    this.ta.className = 'cloudterm-input';
    this.ta.setAttribute('autocomplete', 'off');
    this.ta.setAttribute('autocorrect', 'off');
    this.ta.setAttribute('autocapitalize', 'off');
    this.ta.setAttribute('spellcheck', 'false');
    this.ta.setAttribute('aria-label', 'Terminal');
    this.ta.tabIndex = 0;
    parent.appendChild(this.ta);

    this.ta.addEventListener('keydown', this.boundKeydown);
    this.ta.addEventListener('input', this.boundInput);
    this.ta.addEventListener('paste', this.boundPaste);
  }

  focus(): void {
    this.ta.focus();
  }

  private onKeydown(e: KeyboardEvent): void {
    const out = keyToBytes(e, this.getAppCursor());
    if (out) {
      e.preventDefault();
      this.onData(out);
      if (this.predict) this.emitPrediction(e);
    }
  }

  // Only fires for keys that have a predictable local-echo effect: single
  // printable chars with no Ctrl/Meta, and Backspace. Everything else is
  // either handled by the browser (modifiers consumed), sends a control
  // sequence that does not echo as a visible glyph at the cursor, or is
  // ambiguous enough that guessing wrong would look worse than not guessing.
  private emitPrediction(e: KeyboardEvent): void {
    if (!this.predict) return;
    const ev = keyToPrediction(e);
    if (ev) this.predict(ev);
  }

  private onInput(e: Event): void {
    const ta = e.target as HTMLTextAreaElement;
    const v = ta.value;
    if (v.length > 0) {
      this.onData(ENC.encode(v));
      if (this.predict) {
        // IME / composed chars: predict each resulting code point.
        for (const ch of v) {
          const cc = ch.charCodeAt(0);
          if (cc >= 0x20 && cc !== 0x7f) this.predict({ kind: 'char', ch });
        }
      }
      ta.value = '';
    }
  }

  private onPaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData('text');
    if (text && text.length) {
      e.preventDefault();
      this.onData(pasteToBytes(text, this.getBracketedPaste()));
      // No prediction: shells may rate-limit, wrap in bracketed paste, or
      // mangle pasted content. Let the server's echo be authoritative.
    }
  }

  destroy(): void {
    this.ta.removeEventListener('keydown', this.boundKeydown);
    this.ta.removeEventListener('input', this.boundInput);
    this.ta.removeEventListener('paste', this.boundPaste);
    this.ta.remove();
  }
}
