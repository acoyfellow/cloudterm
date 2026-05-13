# Contributing

Thanks for helping improve cloudterm.

## Local setup

```sh
bun install
bun test
bun run typecheck
bun run build
```

## Development notes

- Keep the browser API small: `mount()` plus `Terminal` methods.
- Add parser/grid/input behavior with tests first when possible.
- Keep `src/style.css` and the injected base CSS in `src/index.ts` in sync.
- Run `bun run smoke` for terminal-behavior changes that need a real PTY.

## Pull requests

Please include:

- what changed and why
- screenshots or a short recording for visible rendering/input changes
- tests or smoke output for parser, keyboard, grid, or renderer changes
