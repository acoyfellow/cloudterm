// Hidden textarea, keyboard + paste -> bytes.
//
// Design: the textarea is positioned offscreen but kept focusable.
// We listen for keydown to map non-printable keys (arrows, enter, ctrl combos)
// to ANSI escape sequences and emit via onData. Printable characters arrive
// via 'input' event (better for IME + special layouts) and are emitted as UTF-8.
// On paste we emit clipboard text as UTF-8.

export interface InputOpts {
  onData: (bytes: Uint8Array) => void;
}

const ENC = new TextEncoder();

function bytes(s: string): Uint8Array {
  return ENC.encode(s);
}

// Map a KeyboardEvent to bytes, or null if we should let the 'input' event handle it.
function keyToBytes(e: KeyboardEvent): Uint8Array | null {
  const key = e.key;
  const ctrl = e.ctrlKey;
  const alt = e.altKey;
  const shift = e.shiftKey;
  const meta = e.metaKey;

  // Allow copy / cmd shortcuts to pass through.
  if (meta && !ctrl) {
    // Don't swallow browser/os shortcuts (Cmd+C, Cmd+V, Cmd+A, etc.)
    // Paste is handled by the 'paste' event.
    return null;
  }

  // Named keys
  switch (key) {
    case 'Enter':
      return bytes('\r');
    case 'Backspace':
      return bytes(ctrl ? '\x08' : '\x7f');
    case 'Tab':
      return bytes(shift ? '\x1b[Z' : '\t');
    case 'Escape':
      return bytes('\x1b');
    case 'ArrowUp':
      return bytes(alt ? '\x1b\x1b[A' : '\x1b[A');
    case 'ArrowDown':
      return bytes(alt ? '\x1b\x1b[B' : '\x1b[B');
    case 'ArrowRight':
      return bytes(alt ? '\x1b\x1b[C' : '\x1b[C');
    case 'ArrowLeft':
      return bytes(alt ? '\x1b\x1b[D' : '\x1b[D');
    case 'Home':
      return bytes('\x1b[H');
    case 'End':
      return bytes('\x1b[F');
    case 'PageUp':
      return bytes('\x1b[5~');
    case 'PageDown':
      return bytes('\x1b[6~');
    case 'Insert':
      return bytes('\x1b[2~');
    case 'Delete':
      return bytes('\x1b[3~');
    case 'F1':
      return bytes('\x1bOP');
    case 'F2':
      return bytes('\x1bOQ');
    case 'F3':
      return bytes('\x1bOR');
    case 'F4':
      return bytes('\x1bOS');
    case 'F5':
      return bytes('\x1b[15~');
    case 'F6':
      return bytes('\x1b[17~');
    case 'F7':
      return bytes('\x1b[18~');
    case 'F8':
      return bytes('\x1b[19~');
    case 'F9':
      return bytes('\x1b[20~');
    case 'F10':
      return bytes('\x1b[21~');
    case 'F11':
      return bytes('\x1b[23~');
    case 'F12':
      return bytes('\x1b[24~');
  }

  // Ctrl + letter -> C0 control code (Ctrl+A = 0x01, Ctrl+Z = 0x1a)
  if (ctrl && !alt && !meta && key.length === 1) {
    const c = key.toLowerCase().charCodeAt(0);
    if (c >= 0x61 && c <= 0x7a) {
      return new Uint8Array([c - 0x60]);
    }
    // Ctrl + [, \, ], ^, _
    switch (key) {
      case '[':
        return new Uint8Array([0x1b]);
      case '\\':
        return new Uint8Array([0x1c]);
      case ']':
        return new Uint8Array([0x1d]);
      case '^':
        return new Uint8Array([0x1e]);
      case '_':
        return new Uint8Array([0x1f]);
      case ' ':
        return new Uint8Array([0x00]);
    }
  }

  // Alt + printable -> ESC + char
  if (alt && !ctrl && !meta && key.length === 1) {
    return bytes('\x1b' + key);
  }

  // Otherwise let the 'input' event deliver printable chars (covers IME).
  return null;
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
