import demoPage from '../demo/index.html';

type CdpEvent = { method: string; params?: Record<string, unknown> };
type CdpResponse = { id: number; result?: Record<string, unknown>; error?: { message: string } };

class CdpClient {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  #events: CdpEvent[] = [];

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data)) as CdpEvent | CdpResponse;
      if ('id' in message) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
      } else {
        this.#events.push(message);
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = this.#nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  events() {
    return this.#events;
  }

  close() {
    this.#socket.close();
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const matches = [...new Bun.Glob(`${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell`).scanSync('.')];
  return matches[0];
}

async function waitFor<T>(action: () => Promise<T>, description: string) {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await Bun.sleep(100);
    }
  }
  throw new Error(`Timed out waiting for ${description}: ${lastError}`);
}

async function openSocket(url: string) {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not connect to Chromium CDP')), { once: true });
  });
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('SKIP demo-check: no headless chromium');
    return;
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    development: { hmr: true },
    routes: { '/': demoPage },
  });
  const cdpPort = 30_000 + Math.floor(Math.random() * 20_000);
  const profile = await Bun.$`mktemp -d`.text();
  const browser = Bun.spawn([chrome, '--headless', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile.trim()}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stderr: 'pipe' });

  try {
    const version = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (!response.ok) throw new Error(response.statusText);
      return await response.json() as { webSocketDebuggerUrl: string };
    }, 'Chromium CDP');
    const cdp = new CdpClient(await openSocket(version.webSocketDebuggerUrl));
    try {
      const target = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${server.port}/` });
      const targetId = target.targetId as string;
      const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = attached.sessionId as string;
      const send = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);

      await send('Runtime.enable');
      await send('Page.enable');
      await waitFor(async () => {
        const result = await send('Runtime.evaluate', { expression: "document.querySelectorAll('.cloudterm-line').length", returnByValue: true });
        if (!result.result) throw new Error('Demo has not initialized');
      }, 'demo initialization');

      const evaluate = async (expression: string) => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(`Page evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
        return (result.result as { value?: unknown } | undefined)?.value;
      };

      const pageErrors = () => cdp.events().filter((event) => event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error');
      await waitFor(async () => {
        const errors = pageErrors();
        if (errors.length) throw new Error(`Page reported errors: ${JSON.stringify(errors)}`);
        if (await evaluate("typeof document.getElementById('write-burst')?.onclick") !== 'function') throw new Error('Demo controls are not ready');
      }, 'demo controls');
      for (const id of ['write-colors', 'write-256', 'write-burst']) await evaluate(`document.getElementById('${id}')?.click()`);
      await evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const result = await waitFor(async () => {
        const value = await evaluate(`(() => { const lines = [...document.querySelectorAll('.cloudterm-line')].map((line) => line.textContent ?? ''); const nonEmpty = lines.filter((line) => line.trim()); return { count: lines.length, last: nonEmpty.at(-1), has9999: lines.some((line) => line.includes('line 9999')) }; })()`);
        const check = value as { count: number; last: string; has9999: boolean };
        if (check.count < 20 || !check.last?.startsWith('$') || !check.has9999) throw new Error(JSON.stringify(check));
        return check;
      }, 'terminal output');
      const errors = pageErrors();
      if (errors.length) throw new Error(`Page reported errors: ${JSON.stringify(errors)}`);
      console.log(`demo-check passed: ${result.count} lines`);
    } finally {
      cdp.close();
    }
  } finally {
    server.stop(true);
    browser.kill();
    await browser.exited;
    await Bun.$`rm -rf ${profile.trim()}`.quiet();
  }
}

main().catch((error) => {
  console.error(`demo-check failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
