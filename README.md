# cloudterm

Tiny DOM-rendered terminal emulator for the web.

[![CI](https://github.com/acoyfellow/cloudterm/actions/workflows/ci.yml/badge.svg)](https://github.com/acoyfellow/cloudterm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Live demo and benchmarks: [termlab.coey.dev](https://termlab.coey.dev/)

## Quick start

Install the package:

```sh
npm i cloudterm
# bun add cloudterm
# pnpm add cloudterm
```

Create a host with an explicit size in `index.html`:

```html
<div id="terminal" style="width: 800px; height: 400px"></div>
<script type="module" src="/main.js"></script>
```

Then put this in `main.js`:

```js
import { mount } from 'cloudterm';
import 'cloudterm/style.css';

const decoder = new TextDecoder();
const el = document.getElementById('terminal');
if (!el) throw new Error('missing #terminal element');

const term = await mount(el, {
  onData(bytes) {
    const text = decoder.decode(bytes);
    console.log('send input to your server:', text);
  },
});

term.write('cloudterm is ready\r\n');
term.focus();
```

The CSS import and a measurable host element are required. `onData` receives a `Uint8Array`; decode it before sending text to a transport. This is everything needed for an embed; full types are below.

## Why

cloudterm renders selectable terminal text in the DOM and leaves the transport to your application. It has one runtime dependency and no framework wrapper.

## Properties

| | |
|---|---|
| Renderer | DOM text with virtualized visible lines |
| Dependencies | 1 (`@chenglou/pretext`) |
| Bundle | 48,483 bytes raw, 14,335 bytes gzip |
| License | MIT |

## How it works

Call `write` with server output. cloudterm parses terminal escapes and paints the visible grid in the host element. Keyboard and paste input arrive at `onData` as bytes for your transport to send; call `focus` after mounting when the terminal should accept input.

## API

```ts
interface Theme {
  background: string;
  foreground: string;
  cursor: string;
  fontFamily: string;
  fontSize: number;
}
interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
}
interface SearchMatch {
  line: number;
  col: number;
  length: number;
}
interface MountOptions {
  onData: (data: Uint8Array) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitle?: (title: string) => void;
  onCwd?: (uri: string) => void;
  onClipboard?: (text: string, selection: string) => void;
  theme?: Partial<Theme>;
  maxScrollback?: number;
  predictionMode?: 'off' | 'auto';
}
interface Terminal {
  write(data: string | Uint8Array): void;
  fit(): void;
  focus(): void;
  destroy(): void;
  search(query: string, opts?: SearchOptions): SearchMatch[];
  findNext(query: string, opts?: SearchOptions): SearchMatch | null;
  findPrevious(query: string, opts?: SearchOptions): SearchMatch | null;
  clearSearch(): void;
  serialize(): string;
  restore(data: string): void;
  readonly cols: number;
  readonly rows: number;
}
declare function mount(el: HTMLElement, opts: MountOptions): Promise<Terminal>;
export { MountOptions, type SearchMatch, type SearchOptions, Terminal, type Theme, mount };
```

- `Theme.background`, `foreground`, `cursor`, `fontFamily`, and `fontSize` set terminal appearance.
- `SearchOptions.caseSensitive` matches letter case; `regex` treats the query as a regular expression.
- `SearchMatch.line`, `col`, and `length` locate one search result.
- `MountOptions.onData` receives terminal input bytes.
- `onResize` receives the measured column and row count.
- `onTitle` receives OSC window-title changes.
- `onCwd` receives OSC current-working-directory URIs.
- `onClipboard` receives OSC clipboard text and its selection name.
- `theme` overrides theme values; `maxScrollback` limits retained lines; `predictionMode` is `'off'` or `'auto'`.
- `Terminal.write` displays text or bytes; `fit` recomputes dimensions; `focus` focuses input; `destroy` removes the terminal.
- `search`, `findNext`, `findPrevious`, and `clearSearch` manage search results.
- `serialize` saves state and `restore` loads it.
- `cols` and `rows` are the current measured dimensions.
- `mount` waits for the host to be measurable and returns a terminal.

## Theme via CSS variables

```css
.cloudterm {
  --ct-bg: #111;
  --ct-fg: #eee;
  --ct-cursor: #4ade80;
  --ct-font: 'JetBrains Mono', monospace;
  --ct-font-size: 14px;
}
```

## Not included

- A shell, PTY, or WebSocket transport
- Framework wrappers or addons
- Canvas or WebGL rendering

## Development

```sh
bun install
bun run build
bun run size
bun run check:readme
bun test
```

## License

MIT. See `LICENSE` for xterm.js attribution on the ported keyboard module.
