import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { InputHandler, type PredictEvent } from './input.js';

function withDom(run: (doc: Document, win: Window) => void): void {
  const win = new Window();
  const prevDoc = globalThis.document;
  const prevEvent = globalThis.Event;
  const prevKeyboardEvent = globalThis.KeyboardEvent;
  Object.assign(globalThis, {
    document: win.document,
    Event: win.Event,
    KeyboardEvent: win.KeyboardEvent,
  });
  try {
    run(win.document as unknown as Document, win);
  } finally {
    Object.assign(globalThis, {
      document: prevDoc,
      Event: prevEvent,
      KeyboardEvent: prevKeyboardEvent,
    });
    win.close();
  }
}

describe('InputHandler keystroke integrity', () => {
  test('predict fires before onData so synchronous echoes reconcile without ghost glyphs', () => {
    withDom((doc, win) => {
      const host = doc.createElement('div');
      const order: string[] = [];
      const handler = new InputHandler(host, {
        onData: (bytes) => { order.push('data:' + new TextDecoder().decode(bytes)); },
        predict: (ev: PredictEvent) => { order.push('predict:' + (ev.kind === 'char' ? ev.ch : ev.kind)); },
      });
      handler.ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'h', keyCode: 72, code: 'KeyH' }) as unknown as Event);
      expect(order).toEqual(['predict:h', 'data:h']);
      handler.destroy();
    });
  });

  test('duplicate input event immediately after handled keydown emits once', () => {
    withDom((doc, win) => {
      const host = doc.createElement('div');
      const sent: string[] = [];
      const handler = new InputHandler(host, {
        onData: (bytes) => { sent.push(new TextDecoder().decode(bytes)); },
      });
      handler.ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', keyCode: 65, code: 'KeyA' }) as unknown as Event);
      handler.ta.value = 'a';
      handler.ta.dispatchEvent(new win.Event('input') as unknown as Event);
      expect(sent).toEqual(['a']);
      handler.destroy();
    });
  });

  test('intentional repeated keystrokes emit every press', () => {
    withDom((doc, win) => {
      const host = doc.createElement('div');
      const sent: string[] = [];
      const handler = new InputHandler(host, {
        onData: (bytes) => { sent.push(new TextDecoder().decode(bytes)); },
      });
      handler.ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'l', keyCode: 76, code: 'KeyL' }) as unknown as Event);
      handler.ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'l', keyCode: 76, code: 'KeyL' }) as unknown as Event);
      expect(sent).toEqual(['l', 'l']);
      handler.destroy();
    });
  });

  test('IME composition emits committed text once and ignores trailing duplicate input', () => {
    withDom((doc, win) => {
      const host = doc.createElement('div');
      const sent: string[] = [];
      const handler = new InputHandler(host, {
        onData: (bytes) => { sent.push(new TextDecoder().decode(bytes)); },
      });
      handler.ta.dispatchEvent(new win.Event('compositionstart') as unknown as Event);
      handler.ta.value = 'n';
      handler.ta.dispatchEvent(new win.Event('input') as unknown as Event);
      const endEv = new win.Event('compositionend') as unknown as CompositionEvent;
      Object.defineProperty(endEv, 'data', { value: '日' });
      handler.ta.dispatchEvent(endEv as unknown as Event);
      handler.ta.value = '日';
      handler.ta.dispatchEvent(new win.Event('input') as unknown as Event);
      expect(sent).toEqual(['日']);
      handler.destroy();
    });
  });
});
