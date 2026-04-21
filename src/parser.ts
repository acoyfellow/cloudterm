// ANSI parser. CSI state machine, OSC capture, SGR to cell attrs.
// Intentionally minimal: covers the subset listed in the cloudterm spec.

export interface CellAttr {
  fg: number; // -1 = default, 0-15 basic, 16-255 xterm 256, 0x01000000|rgb for truecolor
  bg: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
}

export function defaultAttr(): CellAttr {
  return { fg: -1, bg: -1, bold: false, italic: false, underline: false, reverse: false };
}

export interface ParserSink {
  print(ch: string): void;
  lineFeed(): void;
  carriageReturn(): void;
  backspace(): void;
  tab(): void;
  bell(): void;
  // CSI handlers
  cursorUp(n: number): void;
  cursorDown(n: number): void;
  cursorForward(n: number): void;
  cursorBack(n: number): void;
  cursorNextLine(n: number): void;
  cursorPrevLine(n: number): void;
  cursorColumn(col: number): void; // 1-based
  cursorPosition(row: number, col: number): void; // 1-based
  eraseInDisplay(mode: number): void;
  eraseInLine(mode: number): void;
  scrollUp(n: number): void;
  scrollDown(n: number): void;
  saveCursor(): void;
  restoreCursor(): void;
  setAttr(attr: CellAttr): void;
  title(t: string): void;
  // Alternate screen buffer (DEC private modes 47, 1047, 1048, 1049).
  // enabled=true on `h` (set), false on `l` (reset). Flags encode the
  // per-mode behavior: save/restore cursor, clear buffer, perform swap.
  setAltScreen(
    enabled: boolean,
    opts: { save: boolean; clear: boolean; restore: boolean; swap: boolean },
  ): void;
}

// State machine states
const S_GROUND = 0;
const S_ESC = 1;
const S_CSI = 2;
const S_OSC = 3;
const S_OSC_ESC = 4; // seen ESC inside OSC, expecting \
type S = 0 | 1 | 2 | 3 | 4;

export class AnsiParser {
  private state: S = S_GROUND;
  private params: number[] = [];
  private currentParam = -1; // -1 means "empty"
  private intermediate = '';
  private oscBuf = '';
  private attr: CellAttr = defaultAttr();
  // Partial UTF-8 buffer for Uint8Array input
  private utf8Pending: number[] = [];

  constructor(private sink: ParserSink) {}

  reset(): void {
    this.state = S_GROUND;
    this.params = [];
    this.currentParam = -1;
    this.intermediate = '';
    this.oscBuf = '';
    this.attr = defaultAttr();
    this.utf8Pending = [];
  }

  getAttr(): CellAttr {
    return { ...this.attr };
  }

  writeBytes(bytes: Uint8Array): void {
    // Decode UTF-8 incrementally. Stash partials.
    const chunk = this.utf8Pending.length
      ? new Uint8Array([...this.utf8Pending, ...bytes])
      : bytes;
    this.utf8Pending = [];
    // Find last incomplete UTF-8 sequence
    let safeEnd = chunk.length;
    // Look back up to 3 bytes
    for (let i = chunk.length - 1; i >= Math.max(0, chunk.length - 3); i--) {
      const b = chunk[i]!;
      if (b < 0x80) break; // ASCII terminator, chunk is fine
      if (b >= 0xc0) {
        // Start byte. Determine required length.
        const needed =
          b < 0xe0 ? 2 : b < 0xf0 ? 3 : b < 0xf8 ? 4 : 1;
        const remaining = chunk.length - i;
        if (remaining < needed) {
          safeEnd = i;
          for (let j = i; j < chunk.length; j++) this.utf8Pending.push(chunk[j]!);
        }
        break;
      }
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(
      chunk.subarray(0, safeEnd),
    );
    this.writeString(text);
  }

  writeString(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      const code = ch.charCodeAt(0);
      this.step(ch, code);
    }
  }

  private step(ch: string, code: number): void {
    switch (this.state) {
      case S_GROUND:
        this.ground(ch, code);
        return;
      case S_ESC:
        this.esc(ch, code);
        return;
      case S_CSI:
        this.csi(ch, code);
        return;
      case S_OSC:
        this.osc(ch, code);
        return;
      case S_OSC_ESC:
        if (ch === '\\') {
          this.dispatchOsc();
        } else {
          this.oscBuf += '\x1b';
          this.oscBuf += ch;
        }
        this.state = S_OSC;
        return;
    }
  }

  private ground(ch: string, code: number): void {
    if (code === 0x1b) {
      this.state = S_ESC;
      return;
    }
    if (code < 0x20 || code === 0x7f) {
      switch (code) {
        case 0x07:
          this.sink.bell();
          return;
        case 0x08:
          this.sink.backspace();
          return;
        case 0x09:
          this.sink.tab();
          return;
        case 0x0a:
        case 0x0b:
        case 0x0c:
          this.sink.lineFeed();
          return;
        case 0x0d:
          this.sink.carriageReturn();
          return;
        default:
          return; // ignore other C0
      }
    }
    this.sink.print(ch);
  }

  private esc(ch: string, code: number): void {
    if (ch === '[') {
      this.params = [];
      this.currentParam = -1;
      this.intermediate = '';
      this.state = S_CSI;
      return;
    }
    if (ch === ']') {
      this.oscBuf = '';
      this.state = S_OSC;
      return;
    }
    // Simple ESC sequences
    switch (ch) {
      case '7':
        this.sink.saveCursor();
        break;
      case '8':
        this.sink.restoreCursor();
        break;
      case 'D':
        this.sink.lineFeed();
        break;
      case 'E':
        this.sink.carriageReturn();
        this.sink.lineFeed();
        break;
      case 'M':
        this.sink.scrollDown(1);
        break;
      case 'c':
        this.reset();
        break;
      default:
        break;
    }
    // Handle 2-byte ESC sequences that still need another char? Skip for v1.
    this.state = S_GROUND;
    void code;
  }

  private csi(ch: string, code: number): void {
    // CSI = ESC [ P...P I...I F
    // Parameters: digits, separated by ';' or ':'
    if (code >= 0x30 && code <= 0x39) {
      // digit
      if (this.currentParam < 0) this.currentParam = 0;
      this.currentParam = this.currentParam * 10 + (code - 0x30);
      return;
    }
    if (ch === ';' || ch === ':') {
      this.params.push(this.currentParam);
      this.currentParam = -1;
      return;
    }
    if (code >= 0x3c && code <= 0x3f) {
      // Private-mode prefix byte (<, =, >, ?). Must appear before any digits.
      // Store as intermediate so dispatch can detect it.
      this.intermediate += ch;
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      // intermediate (space through /)
      this.intermediate += ch;
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      // final byte
      this.params.push(this.currentParam);
      this.dispatchCsi(ch);
      this.state = S_GROUND;
      this.params = [];
      this.currentParam = -1;
      this.intermediate = '';
      return;
    }
    // bogus
    this.state = S_GROUND;
  }

  private osc(ch: string, code: number): void {
    if (code === 0x07) {
      this.dispatchOsc();
      this.state = S_GROUND;
      return;
    }
    if (code === 0x1b) {
      this.state = S_OSC_ESC;
      return;
    }
    this.oscBuf += ch;
  }

  private dispatchOsc(): void {
    // Format "Ps;Pt". We only care about 0 and 2 (set title).
    const buf = this.oscBuf;
    this.oscBuf = '';
    const idx = buf.indexOf(';');
    if (idx < 0) {
      this.state = S_GROUND;
      return;
    }
    const ps = buf.slice(0, idx);
    const pt = buf.slice(idx + 1);
    if (ps === '0' || ps === '2' || ps === '1') {
      this.sink.title(pt);
    }
    this.state = S_GROUND;
  }

  private p(i: number, def: number): number {
    const v = this.params[i];
    if (v === undefined || v < 0) return def;
    return v;
  }

  private dispatchCsi(final: string): void {
    // Private modes start with '?'. Treat SGR specially when no '?'.
    const isPrivate = this.intermediate.includes('?');
    switch (final) {
      case 'A':
        this.sink.cursorUp(this.p(0, 1));
        return;
      case 'B':
        this.sink.cursorDown(this.p(0, 1));
        return;
      case 'C':
        this.sink.cursorForward(this.p(0, 1));
        return;
      case 'D':
        this.sink.cursorBack(this.p(0, 1));
        return;
      case 'E':
        this.sink.cursorNextLine(this.p(0, 1));
        return;
      case 'F':
        this.sink.cursorPrevLine(this.p(0, 1));
        return;
      case 'G':
        this.sink.cursorColumn(this.p(0, 1));
        return;
      case 'H':
      case 'f':
        this.sink.cursorPosition(this.p(0, 1), this.p(1, 1));
        return;
      case 'J':
        this.sink.eraseInDisplay(this.p(0, 0));
        return;
      case 'K':
        this.sink.eraseInLine(this.p(0, 0));
        return;
      case 'S':
        this.sink.scrollUp(this.p(0, 1));
        return;
      case 'T':
        this.sink.scrollDown(this.p(0, 1));
        return;
      case 'd':
        // row (VPA) — approximate as cursorPosition(row, currentCol). Skip for v1.
        return;
      case 'm':
        if (!isPrivate) this.handleSgr();
        return;
      case 'h':
      case 'l': {
        // DEC private modes. Only alt-screen variants handled here.
        //   47   swap only
        //   1047 swap + clear on exit
        //   1048 save/restore cursor only, no swap
        //   1049 save cursor + swap + clear, restore on exit
        if (!isPrivate) return;
        const enabled = final === 'h';
        for (const ps of this.params) {
          if (ps === 47) {
            this.sink.setAltScreen(enabled, {
              save: false,
              clear: false,
              restore: false,
              swap: true,
            });
          } else if (ps === 1047) {
            this.sink.setAltScreen(enabled, {
              save: false,
              clear: !enabled, // clear alt on exit
              restore: false,
              swap: true,
            });
          } else if (ps === 1048) {
            this.sink.setAltScreen(enabled, {
              save: enabled,
              clear: false,
              restore: !enabled,
              swap: false,
            });
          } else if (ps === 1049) {
            this.sink.setAltScreen(enabled, {
              save: enabled, // save on enter
              clear: true, // clear alt on both enter and exit
              restore: !enabled, // restore on exit
              swap: true,
            });
          }
        }
        return;
      }
      case 's':
        this.sink.saveCursor();
        return;
      case 'u':
        this.sink.restoreCursor();
        return;
      default:
        return;
    }
  }

  private handleSgr(): void {
    const ps = this.params;
    if (ps.length === 0 || (ps.length === 1 && ps[0]! < 0)) {
      this.attr = defaultAttr();
      this.sink.setAttr(this.attr);
      return;
    }
    for (let i = 0; i < ps.length; i++) {
      let n = ps[i]!;
      if (n < 0) n = 0;
      if (n === 0) {
        this.attr = defaultAttr();
      } else if (n === 1) {
        this.attr.bold = true;
      } else if (n === 3) {
        this.attr.italic = true;
      } else if (n === 4) {
        this.attr.underline = true;
      } else if (n === 7) {
        this.attr.reverse = true;
      } else if (n === 22) {
        this.attr.bold = false;
      } else if (n === 23) {
        this.attr.italic = false;
      } else if (n === 24) {
        this.attr.underline = false;
      } else if (n === 27) {
        this.attr.reverse = false;
      } else if (n >= 30 && n <= 37) {
        this.attr.fg = n - 30;
      } else if (n === 38) {
        const next = ps[i + 1];
        if (next === 5 && ps[i + 2] !== undefined) {
          this.attr.fg = ps[i + 2]!;
          i += 2;
        } else if (next === 2 && ps[i + 4] !== undefined) {
          const r = ps[i + 2]! & 0xff;
          const g = ps[i + 3]! & 0xff;
          const b = ps[i + 4]! & 0xff;
          this.attr.fg = 0x01000000 | (r << 16) | (g << 8) | b;
          i += 4;
        }
      } else if (n === 39) {
        this.attr.fg = -1;
      } else if (n >= 40 && n <= 47) {
        this.attr.bg = n - 40;
      } else if (n === 48) {
        const next = ps[i + 1];
        if (next === 5 && ps[i + 2] !== undefined) {
          this.attr.bg = ps[i + 2]!;
          i += 2;
        } else if (next === 2 && ps[i + 4] !== undefined) {
          const r = ps[i + 2]! & 0xff;
          const g = ps[i + 3]! & 0xff;
          const b = ps[i + 4]! & 0xff;
          this.attr.bg = 0x01000000 | (r << 16) | (g << 8) | b;
          i += 4;
        }
      } else if (n === 49) {
        this.attr.bg = -1;
      } else if (n >= 90 && n <= 97) {
        this.attr.fg = n - 90 + 8;
      } else if (n >= 100 && n <= 107) {
        this.attr.bg = n - 100 + 8;
      }
    }
    this.sink.setAttr(this.attr);
  }
}
