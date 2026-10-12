# Changelog

All notable changes to cloudterm will be documented here.

## Unreleased

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
