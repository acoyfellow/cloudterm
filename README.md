# cloudterm

Web terminal emulator. DOM-rendered. Built on @chenglou/pretext.

```sh
bun add cloudterm
```

```ts
import { mount } from 'cloudterm';

const term = await mount(el, { onData: (b) => ws.send(b) });
ws.onmessage = (e) => term.write(e.data);
```

Status: v0.0.1. Minimal by design.

## Properties

| | |
|---|---|
| Renderer | DOM (`<span>`-based, pretext-measured) |
| Parser | Homegrown ANSI / CSI / OSC |
| Dependencies | 1 (@chenglou/pretext) |
| Bundle size | target under 20KB gz |
| License | MIT |

## API

```ts
function mount(el: HTMLElement, opts: MountOptions): Promise<Terminal>;

interface MountOptions {
  onData: (data: Uint8Array) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitle?: (title: string) => void;
  theme?: Partial<Theme>;
  maxScrollback?: number;
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

`mount` is async: it waits for fonts to load and the host element to have a measurable size before resolving.

## Styles

Base styles are injected automatically. To override without `!important`, import the stylesheet and theme via CSS variables:

```ts
import 'cloudterm/style.css';
```

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
| C0 | BS, HT, LF/VT/FF, CR, BEL |
| OSC | 0, 1, 2 (window title) |

## Keyboard

Keyboard handling is ported from xterm.js (`evaluateKeyboardEvent`, MIT). Full xterm modifier encoding: Shift (+1), Alt (+2), Ctrl (+4), Meta (+8), combined via `CSI 1;N <direction>`. Covers:

| Combo | Emits |
|---|---|
| Ctrl+Left / Ctrl+Right | `CSI 1;5D` / `CSI 1;5C` — word jump in zsh/bash |
| Shift+arrow | `CSI 1;2<dir>` — selection extend |
| Alt+B / Alt+F | `ESC b` / `ESC f` — readline word jump |
| Ctrl+A-Z | C0 control codes — full readline control set |
| F1-F12 + modifiers | SS3 / CSI form per xterm spec, 96 combinations |
| Cmd+A / Cmd+C / Cmd+V | passed to browser (select-all, copy, paste) |

Application cursor mode (DECCKM) is not yet threaded from parser to input — TODO. Cursor keys currently emit the non-application form only.

## What's not included

- No canvas/WebGL renderer
- No transport (bring your own WebSocket / PTY)
- No framework wrappers
- No addon system
- No mouse reporting or alt-screen switching
- No link detection
- No built-in selection (browser handles it)

## Related

- [termlab.coey.dev](https://termlab.coey.dev) — side-by-side terminal benchmark, cloudterm in the grid
- [@chenglou/pretext](https://github.com/chenglou/pretext) — text measurement foundation

## License

MIT.
