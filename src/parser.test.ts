import { describe, test, expect } from 'bun:test';
import { AnsiParser, defaultAttr, type CellAttr, type ParserSink } from './parser.js';

// Null sink that records only what each test needs. Anything not listed is a
// no-op. Tests instantiate this, wire the handlers they care about, and feed
// bytes through a real AnsiParser.
function makeSink(overrides: Partial<ParserSink> = {}): ParserSink {
  const noop = (): void => {};
  const base: ParserSink = {
    print: noop,
    lineFeed: noop,
    carriageReturn: noop,
    backspace: noop,
    tab: noop,
    bell: noop,
    cursorUp: noop,
    cursorDown: noop,
    cursorForward: noop,
    cursorBack: noop,
    cursorNextLine: noop,
    cursorPrevLine: noop,
    cursorColumn: noop,
    cursorPosition: noop,
    eraseInDisplay: noop,
    eraseInLine: noop,
    scrollUp: noop,
    scrollDown: noop,
    saveCursor: noop,
    restoreCursor: noop,
    setAttr: (_a: CellAttr) => {
      void _a;
    },
    title: noop,
    setAltScreen: noop,
    setApplicationCursorMode: noop,
    setCursorVisible: noop,
    setAutoWrap: noop,
    setBracketedPaste: noop,
    setMouseTracking: noop,
    setMouseSgr: noop,
    setCurrentDirectory: noop,
  };
  return { ...base, ...overrides };
}

describe('AnsiParser printable ASCII runs', () => {
  test('hands printable runs to sinks that support them around escape sequences', () => {
    const events: string[] = [];
    const parser = new AnsiParser(
      makeSink({
        printRun: (text) => events.push(`run:${text}`),
        print: (ch) => events.push(`print:${ch}`),
        setAttr: () => events.push('attr'),
      }),
    );
    parser.writeString('hello\x1b[31mX');
    expect(events).toEqual(['run:hello', 'attr', 'run:X']);
  });

  test('falls back to individual print calls without printRun', () => {
    const printed: string[] = [];
    const parser = new AnsiParser(makeSink({ print: (ch) => printed.push(ch) }));
    parser.writeString('hello');
    expect(printed).toEqual(['h', 'e', 'l', 'l', 'o']);
  });
});

describe('AnsiParser Unicode input', () => {
  test('prints an emoji once', () => {
    const printed: string[] = [];
    const parser = new AnsiParser(makeSink({ print: (ch) => printed.push(ch) }));
    parser.writeString('\u{1f600}');
    expect(printed).toEqual(['\u{1f600}']);
  });

  test('joins a surrogate pair split across writes', () => {
    const printed: string[] = [];
    const parser = new AnsiParser(makeSink({ print: (ch) => printed.push(ch) }));
    parser.writeString('\ud83d');
    parser.writeString('\ude00');
    expect(printed).toEqual(['\u{1f600}']);
  });
});

describe('AnsiParser DEC private modes', () => {
  test('CSI ?25 h/l dispatches cursor visibility', () => {
    const visibility: boolean[] = [];
    const parser = new AnsiParser(makeSink({ setCursorVisible: (enabled) => visibility.push(enabled) }));
    parser.writeString('\x1b[?25l\x1b[?25h');
    expect(visibility).toEqual([false, true]);
  });

  test('CSI ?7 h/l dispatches auto-wrap', () => {
    const autoWrap: boolean[] = [];
    const parser = new AnsiParser(makeSink({ setAutoWrap: (enabled) => autoWrap.push(enabled) }));
    parser.writeString('\x1b[?7l\x1b[?7h');
    expect(autoWrap).toEqual([false, true]);
  });

  test('mouse tracking and SGR modes dispatch and reset', () => {
    const tracking: number[] = [];
    const sgr: boolean[] = [];
    const parser = new AnsiParser(makeSink({
      setMouseTracking: (mode) => tracking.push(mode),
      setMouseSgr: (enabled) => sgr.push(enabled),
    }));
    parser.writeString('\x1b[?9h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
    parser.writeString('\x1b[?1003l\x1b[?1006l\x1bc');
    expect(tracking).toEqual([9, 1000, 1002, 1003, 0, 0]);
    expect(sgr).toEqual([true, false, false]);
  });
});

describe('AnsiParser OSC 7 (current working directory)', () => {
  test('BEL-terminated OSC 7 calls setCurrentDirectory with the URI', () => {
    const cwds: string[] = [];
    const parser = new AnsiParser(makeSink({ setCurrentDirectory: (u) => cwds.push(u) }));
    parser.writeString('\x1b]7;file://host/home/user\x07');
    expect(cwds).toEqual(['file://host/home/user']);
  });

  test('ST-terminated OSC 7 (ESC \\) also dispatches', () => {
    const cwds: string[] = [];
    const parser = new AnsiParser(makeSink({ setCurrentDirectory: (u) => cwds.push(u) }));
    parser.writeString('\x1b]7;file://host/var/log\x1b\\');
    expect(cwds).toEqual(['file://host/var/log']);
  });

  test('OSC 7 does not fire the title callback', () => {
    const titles: string[] = [];
    const cwds: string[] = [];
    const parser = new AnsiParser(
      makeSink({
        title: (t) => titles.push(t),
        setCurrentDirectory: (u) => cwds.push(u),
      }),
    );
    parser.writeString('\x1b]7;file://host/tmp\x07');
    expect(titles).toEqual([]);
    expect(cwds).toEqual(['file://host/tmp']);
  });

  test('OSC 0/1/2 still fire title, not setCurrentDirectory', () => {
    const titles: string[] = [];
    const cwds: string[] = [];
    const parser = new AnsiParser(
      makeSink({
        title: (t) => titles.push(t),
        setCurrentDirectory: (u) => cwds.push(u),
      }),
    );
    parser.writeString('\x1b]0;window title\x07');
    parser.writeString('\x1b]2;another title\x07');
    expect(titles).toEqual(['window title', 'another title']);
    expect(cwds).toEqual([]);
  });

  test('unknown OSC codes fall through silently', () => {
    // Regression: OSC 52 (clipboard), OSC 10 (fg color), etc. must not call
    // either handler. We do not implement them; feeding them should be inert.
    const titles: string[] = [];
    const cwds: string[] = [];
    const parser = new AnsiParser(
      makeSink({
        title: (t) => titles.push(t),
        setCurrentDirectory: (u) => cwds.push(u),
      }),
    );
    parser.writeString('\x1b]52;c;aGVsbG8=\x07');
    parser.writeString('\x1b]10;#ffffff\x07');
    expect(titles).toEqual([]);
    expect(cwds).toEqual([]);
  });
});

// Smoke: confirm defaultAttr is a stable shape. Several tests build on it.
describe('AnsiParser defaultAttr', () => {
  test('returns a fresh object on every call', () => {
    const a = defaultAttr();
    const b = defaultAttr();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('AnsiParser charset designation (ESC ( B)', () => {
  test('ESC ( B does not print the B', () => {
    let printed = '';
    const parser = new AnsiParser(makeSink({ print: (ch: string) => { printed += ch; } }));
    parser.writeString('\x1b(B\x1b[mhi');
    expect(printed).toBe('hi');
  });

  test('tmux attach stream prints the shell prompt', () => {
    let printed = '';
    const parser = new AnsiParser(makeSink({ print: (ch: string) => { printed += ch; } }));
    parser.writeString('\x1b[?2004h\x1b(B\x1b[m\x1b[1;1Hbash-5.3# ');
    expect(printed).toBe('bash-5.3# ');
  });
});

describe('AnsiParser string terminators', () => {
  const printedAfter = (input: string) => {
    let printed = '';
    const parser = new AnsiParser(makeSink({ print: (ch: string) => { printed += ch; } }));
    parser.writeString(input);
    return printed;
  };

  test('OSC ended by ST returns to ground', () => {
    expect(printedAfter('\x1b]11;?\x1b\\hello')).toBe('hello');
  });

  test('DCS string is dropped up to ST', () => {
    expect(printedAfter('\x1bP>|tmux 3.5a\x1b\\hello')).toBe('hello');
  });

  test('tmux color queries do not swallow the screen', () => {
    expect(printedAfter('\x1b]10;?\x1b\\\x1b]11;?\x1b\\bash-5.3# ')).toBe('bash-5.3# ');
  });
});
