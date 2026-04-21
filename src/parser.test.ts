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
    setBracketedPaste: noop,
    setCurrentDirectory: noop,
  };
  return { ...base, ...overrides };
}

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
