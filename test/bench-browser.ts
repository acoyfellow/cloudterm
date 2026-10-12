import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const rounds = Number(process.argv.find((arg) => arg.startsWith('--rounds='))?.slice(9) ?? 5);
const root = join(import.meta.dir, '..');
const cols = 120;
const rows = 40;
const workloads = {
  'scroll-flood': { input: Array.from({ length: 100000 }, (_, index) => `line ${index} ${'x'.repeat(80)}`).join('\r\n') + '\r\nEND-SCROLL', marker: 'END-SCROLL' },
  'full-redraw': { input: Array.from({ length: 1500 }, (_, frame) => '\x1b[H' + Array.from({ length: rows - 1 }, (_, row) => `\x1b[3${(frame + row) % 8}m${`${frame}:${row} `.padEnd(cols - 1, '#')}\x1b[0m`).join('\r\n')).join('') + '\r\nEND-REDRAW', marker: 'END-REDRAW' },
  'sgr-tokens': { input: '\x1b[32mfoo\x1b[0m '.repeat(100000) + '\r\nEND-SGR', marker: 'END-SGR' },
};

const bundle = await Bun.build({ entrypoints: [join(root, 'src/index.ts')], target: 'browser', format: 'esm', outdir: '/tmp/cloudterm-bench-browser', write: false });
const output = new Map(await Promise.all(bundle.outputs.map(async (file) => [`/${file.path.split('/').pop()!}`, await file.arrayBuffer()] as const)));
const page = `<!doctype html><script>window.addEventListener('error',event=>window.loadError=event.message)</script><div id="host"></div><style>html,body{margin:0;background:#000}#host{width:${cols * 9}px;height:${rows * 18}px}</style><script type="module">import { mount } from '/index.js';const host=document.getElementById('host');const workloads=${JSON.stringify(workloads)};const frame=()=>new Promise(r=>requestAnimationFrame(r));window.run=async name=>{host.innerHTML='';let paintMs=0;const terminal=await mount(host,{onData(){},predictionMode:'off'});await frame();const workload=workloads[name];const start=performance.now();for(let offset=0;offset<workload.input.length;offset+=16384){const paintStart=performance.now();terminal.write(workload.input.slice(offset,offset+16384));paintMs+=performance.now()-paintStart;}const deadline=start+30000;while(performance.now()<deadline){await frame();if(host.innerText.includes(workload.marker)){await frame();const result={wallMs:performance.now()-start,paintMs};terminal.destroy();return result}}throw new Error('marker not visible')};window.ready=true;</script>`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) { const path = new URL(request.url).pathname; const file = output.get(path); return path === '/' ? new Response(page, { headers: { 'content-type': 'text/html' } }) : file ? new Response(file, { headers: { 'content-type': 'text/javascript' } }) : new Response('not found', { status: 404 }); } });
const cache = join(homedir(), 'Library/Caches/ms-playwright');
const shell = readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell')).sort().pop()!;
const directory = join(cache, shell);
const binary = join(directory, readdirSync(directory).find((name) => name.startsWith('chrome-headless-shell'))!, 'chrome-headless-shell');

async function sample(workload: keyof typeof workloads, port: number): Promise<{ wallMs: number; paintMs: number }> {
  const chrome = spawn(binary, [`--remote-debugging-port=${port}`, '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let ws = '';
    for (let attempt = 0; attempt < 80 && !ws; attempt++) { try { ws = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((target) => target.type === 'page')?.webSocketDebuggerUrl ?? ''; } catch {} if (!ws) await Bun.sleep(100); }
    const socket = new WebSocket(ws);
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve(), { once: true }));
    let id = 0;
    const pending = new Map<number, (message: any) => void>();
    socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)); if (message.id) pending.get(message.id)?.(message); });
    const send = (method: string, params: object = {}) => new Promise<any>((resolve) => { const requestId = ++id; pending.set(requestId, resolve); socket.send(JSON.stringify({ id: requestId, method, params })); });
    await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${server.port}` });
    let ready = false; for (let attempt = 0; attempt < 100; attempt++) { const result = await send('Runtime.evaluate', { expression: 'window.ready === true', returnByValue: true }); if (result.result?.result?.value) { ready = true; break; } await Bun.sleep(100); }
    if (!ready) { const error = await send('Runtime.evaluate', { expression: 'window.loadError', returnByValue: true }); throw new Error(`page did not load: ${error.result?.result?.value}`); }
    const result = await send('Runtime.evaluate', { expression: `run(${JSON.stringify(workload)})`, awaitPromise: true, returnByValue: true, timeout: 60000 });
    socket.close();
    if (!result.result?.result?.value) throw new Error(JSON.stringify(result.result?.exceptionDetails));
    return result.result.result.value;
  } finally { chrome.kill('SIGKILL'); }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const results: Record<string, { wallMs: number[]; paintMs: number[] }> = {};
let port = 9510;
for (const name of Object.keys(workloads) as Array<keyof typeof workloads>) for (let round = 0; round < rounds; round++) { const value = await sample(name, port++); const result = results[name] ??= { wallMs: [], paintMs: [] }; result.wallMs.push(value.wallMs); result.paintMs.push(value.paintMs); process.stderr.write(`${name} ${round + 1}/${rounds}: ${value.wallMs.toFixed(1)}ms wall, ${value.paintMs.toFixed(1)}ms paint\n`); }
server.stop(true);
console.table(Object.entries(results).map(([name, value]) => ({ workload: name, wallMs: Math.round(median(value.wallMs)), paintMs: Math.round(median(value.paintMs)), samples: value.wallMs.map((sample) => Math.round(sample)).join(', ') })));
