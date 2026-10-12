import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { InputHandler } from './input.js';

const window = new Window();
Object.assign(globalThis, { window, document: window.document });

test('focusing the terminal input never scrolls the page to it', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const input = new InputHandler(host, { onData: () => undefined });
  const calls: unknown[] = [];
  input.ta.focus = (options?: FocusOptions) => void calls.push(options);
  input.focus();
  expect(calls).toEqual([{ preventScroll: true }]);
});
