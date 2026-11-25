# Changelog

All notable changes to cloudterm will be documented here.

## Unreleased

## 0.0.17

- Terminal query replies: DA1 (`CSI c`), DA2 (`CSI > c`), DA3 (`CSI = c`), DSR (`CSI 5n` / `CSI 6n`), XTVERSION (`CSI > q`), and OSC 10/11/12 color queries (VT conformance 12/18 -> 15/18).
- Faster SGR and DOM paint: inline simple SGR parsing, deferred dirty-row set creation until paint, WeakMap attribute-code interning, and typed-row rendering without `Cell` materialization.
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
