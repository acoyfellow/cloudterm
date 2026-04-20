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

## What's not included

- No canvas/WebGL renderer
- No transport (bring your own WebSocket / PTY)
- No framework wrappers
- No addon system
- No mouse reporting or alt-screen switching
- No link detection
- No built-in selection (browser handles it)
- No tests (yet)

## Related

- [termlab.coey.dev](https://termlab.coey.dev) — side-by-side terminal benchmark, cloudterm in the grid
- [@chenglou/pretext](https://github.com/chenglou/pretext) — text measurement foundation

## License

MIT.
