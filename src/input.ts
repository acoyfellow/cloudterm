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
}

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
// TODO: thread applicationCursorMode through from Grid. The shell sets it via
// DECSET `CSI ?1h` / `CSI ?1l` (vim, less, etc.). For now hardcoded false so
// cursor keys emit the non-application form (`ESC [ A` vs `ESC O A`).
export function keyToBytes(e: KeyLike): Uint8Array | null {
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
  const result = evaluateKeyboardEvent(ev, false, isMac(), true);
  if (result.type !== KeyboardResultType.SEND_KEY) return null;
  if (!result.key) return null;
  return ENC.encode(result.key);
}

export class InputHandler {
  ta: HTMLTextAreaElement;
  private onData: (b: Uint8Array) => void;
  private boundKeydown = this.onKeydown.bind(this);
  private boundInput = this.onInput.bind(this);
  private boundPaste = this.onPaste.bind(this);

  constructor(parent: HTMLElement, opts: InputOpts) {
    this.onData = opts.onData;
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
    const out = keyToBytes(e);
    if (out) {
      e.preventDefault();
      this.onData(out);
    }
  }

  private onInput(e: Event): void {
    const ta = e.target as HTMLTextAreaElement;
    const v = ta.value;
    if (v.length > 0) {
      this.onData(ENC.encode(v));
      ta.value = '';
    }
  }

  private onPaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData('text');
    if (text && text.length) {
      e.preventDefault();
      this.onData(ENC.encode(text));
    }
  }

  destroy(): void {
    this.ta.removeEventListener('keydown', this.boundKeydown);
    this.ta.removeEventListener('input', this.boundInput);
    this.ta.removeEventListener('paste', this.boundPaste);
    this.ta.remove();
  }
}
