# Changelog

All notable changes to cloudterm will be documented here.

## Unreleased

## 0.0.17

- **VT conformance 12/18 → 18/18:** DA1/DA2/DA3, DSR (`CSI 5n` / `CSI 6n`), XTVERSION (`CSI > q`), OSC 10/11/12 color queries, DEC Special Graphics (`ESC ( 0` / `ESC ( B`), custom tab stops (`CSI g` TBC / `ESC H` HTS), real line reflow on resize, and synchronized output (`CSI ?2026h/l`).
- **General usability 5/10 → 10/10:** fix prediction ordering (predict before `onData` so local/fast echoes never double), add IME composition handling, and deduplicate `keydown`+`input`.
- **Interactive input-to-display latency:** microtask flush for small interactive writes, single-dirty-row fast path, and skipped unchanged style writes (DOM ready 9.0 ms → 0.8 ms; display commit 15.7 ms → 9.6–12.9 ms).
- **Throughput:** packed `writeChar`/`clearCell`/`eraseInLine`, cached `stringWidths`, 16-bit attribute table, inline `CSI H`/`CSI K` + 256/truecolor SGR parsing, minimal span styles, in-place line recycling, and bottom-pinned overscan.
- Live public demo deployed at `cloudterm.customer0.dev` with Agent Vision DOM inspector.

## 0.0.16

- Typed-array grid rows, fused parser ASCII scan into grid writes, and deferred recycled row clearing.

## 0.0.15

- Null-safe mount quick-start example and updated `llms.txt` summary.

## 0.0.14

- Self-contained README quick start, full API docs, and `llms.txt`.

## 0.0.13

- Mounting or focusing a terminal no longer scrolls the page to it (`focus({ preventScroll: true })`).
- DOM renderer writes each span's style in one attribute instead of up to seven property calls.

## 0.0.12

- Faster parser and grid: printable ASCII is written a row segment at a time, single-code SGR changes are cached, rows evicted from a full scrollback are reused, and mount skips a frame when fonts are loaded and the host has a size. Against 0.0.11 (bench-compare, 5 rounds): sgr-tokens -49%, scroll-flood -52%, full-redraw -66%.
- `bun run fuzz` compares parser and grid state with a reference tag on random input.

- Polished README for public sharing.
- Added project health files: CI, security policy, contributing guide, issue templates, PR template, and docs index.

## 0.0.3

- DOM renderer with line virtualization.
- ANSI / CSI / OSC parser.
- xterm-style keyboard input.
- Alternate-screen, application-cursor, and bracketed-paste mode support.
- Speculative local echo overlay.
