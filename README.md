# cloudterm

Tiny DOM terminal emulator for the web. It renders terminal output as real text, handles xterm-style keyboard input, and stays small enough to embed anywhere.

[![CI](https://github.com/acoyfellow/cloudterm/actions/workflows/ci.yml/badge.svg)](https://github.com/acoyfellow/cloudterm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Live demo / benchmark:** [termlab.coey.dev](https://termlab.coey.dev/)

## Why

Most browser terminals are canvas-heavy, addon-heavy, or tightly coupled to a transport. cloudterm is the opposite:

- **DOM-rendered text** — selectable, inspectable `<span>` runs instead of canvas pixels
- **Virtualized painting** — only visible lines plus overscan are in the DOM
- **Small surface area** — one dependency, no addons, no framework wrapper
- **Bring your own transport** — wire it to a PTY, WebSocket, Worker, or test harness
- **Speculative local echo** — optional client-side prediction for high-latency shells

## Install

```sh
bun add github:acoyfellow/cloudterm#v0.0.3
```

## Use

```ts
import { mount } from 'cloudterm';
import 'cloudterm/style.css';

const term = await mount(el, {
  onData: (bytes) => ws.send(bytes),
  onResize: (cols, rows) => resizePty(cols, rows),
});

ws.onmessage = (event) => term.write(event.data);
term.focus();
```

`cloudterm` does not create a shell or WebSocket for you. It is the terminal UI layer: bytes in, bytes out.

## Properties

| | |
|---|---|
| Renderer | DOM (`<span>` runs, pretext-measured, line-virtualized) |
| Parser | ANSI / CSI / OSC state machine |
| Keyboard | Ported from xterm.js `evaluateKeyboardEvent` |
| Dependencies | 1 (`@chenglou/pretext`) |
| Bundle | 21 KB raw, 6.7 KB gz |
| License | MIT |

## How it works

Input goes `textarea -> keydown/input/paste -> evaluateKeyboardEvent -> onData bytes`. A hidden textarea overlays the host at `opacity:0` so clicks focus naturally and the browser gives us IME, paste, and platform shortcuts for free.

Output goes `write(bytes) -> ANSI parser -> Grid (cells + scrollback) -> DomRenderer -> rAF paint`. The renderer only paints visible lines plus an overscan band; line height and char width come from `@chenglou/pretext` at mount time, avoiding layout reads in the hot paint path.

```
  ┌─ input path ─────────────────────────────┐    ┌─ output path ──────────────────────┐
  │  textarea.keydown/input/paste            │    │  write(data)                       │
  │     → evaluateKeyboardEvent (xterm port) │    │     → AnsiParser (CSI/OSC/SGR)     │
  │     → MountOptions.onData(Uint8Array)    │    │     → Grid (cells, scrollback)     │
  │     → you send to PTY / WebSocket        │    │     → DomRenderer.paint() on rAF   │
  └──────────────────────────────────────────┘    └────────────────────────────────────┘
```

## API

```ts
function mount(el: HTMLElement, opts: MountOptions): Promise<Terminal>;

interface MountOptions {
  onData: (data: Uint8Array) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitle?: (title: string) => void;
  onCwd?: (uri: string) => void;
  theme?: Partial<Theme>;
  maxScrollback?: number;
  predictionMode?: 'off' | 'auto'; // default 'auto'
}

interface Terminal {
  write(data: string | Uint8Array): void;
  fit(): void;
  focus(): void;
  destroy(): void;
  readonly cols: number;
  readonly rows: number;
}

interface Theme {
  background: string;
  foreground: string;
  cursor: string;
  fontFamily: string;
  fontSize: number;
}
```

`mount` is async. It waits for fonts and a measurable host element before resolving.

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

## Supported escapes

| Category | Sequences |
|---|---|
| SGR | 0, 1, 3, 4, 7, 22, 23, 24, 27, 30-37, 38;5;N, 38;2;r;g;b, 39, 40-47, 48;5;N, 48;2;r;g;b, 49, 90-97, 100-107 |
| Cursor | CUU/CUD/CUF/CUB, CNL/CPL, CHA, CUP, save/restore |
| Erase | ED (0/1/2/3), EL (0/1/2) |
| Scroll | SU, SD |
| Modes | alt screen (`?47`, `?1047`, `?1049`), application cursor (`?1`), bracketed paste (`?2004`) |
| C0 | BS, HT, LF/VT/FF, CR, BEL |
| OSC | 0, 1, 2 (window title), 7 (current working directory) |

## Supported keys

| Combo | Emits |
|---|---|
| Ctrl+Left / Ctrl+Right | `CSI 1;5D` / `CSI 1;5C` |
| Shift+Arrow | `CSI 1;2<dir>` |
| Alt+B / Alt+F | `ESC b` / `ESC f` |
| Ctrl+A through Ctrl+Z | C0 0x01 through 0x1a |
| F1-F12 with any modifier | SS3 / CSI form, 96 combinations |
| Home / End / PageUp / PageDown / Insert / Delete | per xterm spec |
| Cmd+A / Cmd+C / Cmd+V | null (browser handles) |

## Speculative local echo

Typed characters paint as a dimmed overlay at the predicted cursor position while the client waits for the server's echo. When the echo arrives, the overlay cell and the authoritative cell agree and the user sees no glitch. When they disagree, the authoritative paint overwrites the overlay.

The overlay is client-only: the authoritative `Grid` is never touched speculatively. Predictions are recorded for printable characters and Backspace; control sequences, arrow keys, Cmd-combos, and pastes do not generate predictions. Predictions are disabled automatically while the alternate-screen buffer is active (vim, less, tmux) or while DECCKM is set.

Set `predictionMode: 'off'` in `MountOptions` to disable the whole system.

**Known limitation:** Password prompts that use `stty -echo` do not echo typed characters back. cloudterm paints the predicted character, then the 500ms TTL sweeps it away. The overlay briefly shows the typed character. This is a client-only leak onto the user's own screen; the character is never transmitted anywhere the server did not intend. A full fix requires tracking the PTY's echo mode, which cloudterm does not do.

## Not included

- No canvas or WebGL renderer
- No transport (bring your own WebSocket or PTY)
- No framework wrappers
- No addon system
- No mouse reporting
- No link detection
- No built-in selection layer (browser selection handles DOM text)
- No per-RTT calibration for speculative echo (always on when enabled)

## Demo

Try cloudterm in the browser at [termlab.coey.dev](https://termlab.coey.dev/). The demo compares rendering behavior side-by-side and is the easiest way to see the DOM renderer, keyboard path, and speculative local echo in action.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

There is also a real-PTY smoke harness:

```sh
bun run smoke
```

It drives a shell through `node-pty`, feeds the resulting bytes into cloudterm's headless parser/grid, and writes `test/REPORT.md` for inspection.

## Related

- [termlab.coey.dev](https://termlab.coey.dev/) — cloudterm in a live side-by-side benchmark
- [@chenglou/pretext](https://github.com/chenglou/pretext) — text measurement foundation
- [xterm.js](https://github.com/xtermjs/xterm.js) — keyboard handling ported from here

## License

MIT. See `LICENSE` for xterm.js attribution on the ported keyboard module.
