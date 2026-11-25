import { mount } from '../src/index.ts';

const host = document.getElementById('term') as HTMLDivElement;
const stage = document.getElementById('stage') as HTMLElement;
const sizeLabel = document.getElementById('size') as HTMLSpanElement;
const writeLabel = document.getElementById('write-ms') as HTMLSpanElement;
const focusState = document.getElementById('focus-state') as HTMLSpanElement;
const xrayLines = document.getElementById('xray-lines') as HTMLElement;
const xrayNodes = document.getElementById('xray-nodes') as HTMLElement;
const xrayTokens = document.getElementById('xray-tokens') as HTMLElement;
const xrayReplies = document.getElementById('xray-replies') as HTMLElement;
const xrayText = document.getElementById('xray-text') as HTMLPreElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const toggleXray = document.getElementById('toggle-xray') as HTMLButtonElement;

const decoder = new TextDecoder();
const encoder = new TextEncoder();
let lineBuf = '';
let replyCount = 0;
let xrayTimer = 0;
const history: string[] = [];
let historyIdx = 0;

function updateXray(): void {
  const lines = [...host.querySelectorAll('.cloudterm-line')].map((el) => el.textContent ?? '');
  const text = lines.join('\n').trimEnd();
  xrayLines.textContent = String(lines.length);
  xrayNodes.textContent = String(host.querySelectorAll('*').length);
  xrayTokens.textContent = String(Math.ceil(encoder.encode(text).length / 4));
  xrayReplies.textContent = String(replyCount);
  xrayText.textContent = text;
}

function scheduleXray(): void {
  if (xrayTimer) return;
  xrayTimer = requestAnimationFrame(() => {
    xrayTimer = 0;
    updateXray();
  });
}

function timedWrite(payload: string): void {
  const t0 = performance.now();
  term.write(payload);
  requestAnimationFrame(() => {
    const ms = performance.now() - t0;
    writeLabel.textContent = `write ${ms.toFixed(1)} ms`;
    updateXray();
  });
}

function runCommand(raw: string): void {
  const cmd = raw.trim();
  if (!cmd) {
    term.write('\r\n$ ');
    return;
  }
  history.push(cmd);
  historyIdx = history.length;
  if (cmd === 'help') {
    term.write(
      '\r\n\x1b[1mcommands:\x1b[0m help, ls, colors, 256, tui, unicode, query, burst, date, clear\r\n' +
      'Try Cmd+F in your browser or drag-select any line.\r\n$ ',
    );
  } else if (cmd === 'ls') {
    term.write(
      '\r\n\x1b[1;34msrc/\x1b[0m  \x1b[38;5;208mpackage.json\x1b[0m  \x1b[38;2;90;210;160mdist/index.js\x1b[0m  README.md  llms.txt\r\n$ ',
    );
  } else if (cmd === 'colors') {
    writeColors();
  } else if (cmd === '256') {
    write256();
  } else if (cmd === 'tui') {
    writeTui();
  } else if (cmd === 'unicode') {
    writeUnicode();
  } else if (cmd === 'burst') {
    writeBurst();
  } else if (cmd === 'date') {
    term.write(`\r\n${new Date().toISOString()}\r\n$ `);
  } else if (cmd === 'query') {
    term.write('\r\nSending CSI c (DA1) + CSI 6n (cursor position) + OSC 11;? ...\r\n\x1b[c\x1b[6n\x1b]11;?\x07$ ');
  } else if (cmd === 'clear') {
    term.write('\x1b[2J\x1b[H$ ');
  } else {
    term.write(`\r\n\x1b[31munknown command:\x1b[0m ${cmd} (type \x1b[1mhelp\x1b[0m)\r\n$ `);
  }
  scheduleXray();
}

const term = await mount(host, {
  onData: (bytes) => {
    const s = decoder.decode(bytes);
    if (s.startsWith('\x1b[?') || s.startsWith('\x1b[>') || s.startsWith('\x1bP') || s.startsWith('\x1b]') || new RegExp('^\\x1b\\[[0-9;]+R$').test(s)) {
      replyCount++;
      term.write(`\x1b[38;5;81m[reply] ${JSON.stringify(s)}\x1b[0m\r\n`);
      scheduleXray();
      return;
    }
    if (s === '\r') {
      const cmd = lineBuf;
      lineBuf = '';
      runCommand(cmd);
    } else if (s === '\x03') {
      lineBuf = '';
      term.write('^C\r\n$ ');
      scheduleXray();
    } else if (s === '\x7f') {
      if (lineBuf.length > 0) {
        lineBuf = lineBuf.slice(0, -1);
        term.write('\b \b');
        scheduleXray();
      }
    } else if (s === '\x1b[A') {
      if (historyIdx > 0) {
        historyIdx--;
        term.write('\r\x1b[K$ ' + history[historyIdx]);
        lineBuf = history[historyIdx] ?? '';
        scheduleXray();
      }
    } else if (s === '\x1b[B') {
      if (historyIdx < history.length) {
        historyIdx++;
        const next = history[historyIdx] ?? '';
        term.write('\r\x1b[K$ ' + next);
        lineBuf = next;
        scheduleXray();
      }
    } else if (s >= ' ') {
      lineBuf += s;
      term.write(s);
      scheduleXray();
    }
  },
  onResize: (cols, rows) => {
    sizeLabel.textContent = `${cols} x ${rows}`;
    scheduleXray();
  },
  onTitle: (t) => {
    document.title = `cloudterm · ${t}`;
  },
});

const setFocused = (on: boolean) => {
  focusState.textContent = on ? 'FOCUSED' : 'BLURRED';
  focusState.classList.toggle('focused', on);
  focusState.classList.toggle('blurred', !on);
};
host.addEventListener('focusin', () => setFocused(true));
host.addEventListener('focusout', () => {
  queueMicrotask(() => {
    const ta = host.querySelector('.cloudterm-input');
    setFocused(ta === document.activeElement);
  });
});
queueMicrotask(() => {
  const ta = host.querySelector('.cloudterm-input');
  setFocused(ta === document.activeElement);
});

function writeSample(): void {
  timedWrite(
    '\r\n\x1b]2;DOM web terminal\x07' +
    '\x1b[1mbold\x1b[0m  \x1b[3mitalic\x1b[0m  \x1b[4munderline\x1b[0m  \x1b[7m reverse \x1b[0m\r\n' +
    '\x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m \x1b[33myellow\x1b[0m \x1b[34mblue\x1b[0m \x1b[35mmagenta\x1b[0m \x1b[36mcyan\x1b[0m\r\n' +
    'truecolor: \x1b[38;2;243;128;32m#f38020\x1b[0m \x1b[38;2;56;199;122m#38c77a\x1b[0m \x1b[38;2;124;196;255m#7cc4ff\x1b[0m\r\n$ ',
  );
  term.focus();
}

function writeColors(): void {
  let out = '\r\n';
  for (let i = 30; i < 38; i++) out += `\x1b[${i}m${i} `;
  out += '\x1b[0m\r\n';
  for (let i = 90; i < 98; i++) out += `\x1b[${i}m${i} `;
  out += '\x1b[0m\r\n$ ';
  timedWrite(out);
  term.focus();
}

function write256(): void {
  let out = '\r\n';
  for (let i = 0; i < 256; i++) {
    out += `\x1b[48;5;${i}m ${i.toString().padStart(3, ' ')} \x1b[0m`;
    if ((i + 1) % 16 === 0) out += '\r\n';
  }
  timedWrite(out + '$ ');
  term.focus();
}

function writeTui(): void {
  const w = Math.max(40, Math.min(term.cols - 2, 74));
  const bar = '─'.repeat(w - 2);
  const out = [
    '\r\n\x1b[38;2;96;115;138m┌' + bar + '┐\x1b[0m',
    `\x1b[38;2;96;115;138m│\x1b[0m \x1b[1;38;2;120;220;180mcloudterm live dashboard\x1b[0m   \x1b[38;5;214m16 KB gz\x1b[0m   \x1b[38;5;81m11/11 AX\x1b[0m   \x1b[38;5;141m0 WASM\x1b[0m`,
    '\x1b[38;2;96;115;138m├' + bar + '┤\x1b[0m',
    '\x1b[38;2;96;115;138m│\x1b[0m \x1b[38;2;115;210;155mPASS\x1b[0m scroll-flood    36.4 ms CPU  (DOM virtualized, 10k scrollback)',
    '\x1b[38;2;96;115;138m│\x1b[0m \x1b[38;2;115;210;155mPASS\x1b[0m full-redraw     24.0 ms CPU  (typed-array grid + fused ASCII)',
    '\x1b[38;2;96;115;138m│\x1b[0m \x1b[38;2;240;195;90mINFO\x1b[0m conformance     15/18 VT     (DA1, DA2, DA3, DSR 5n/6n, OSC 10-12)',
    '\x1b[38;2;96;115;138m│\x1b[0m \x1b[7m STATUS \x1b[27m [████████████████████████████░░░░░░░░] 70%  selectable DOM text',
    '\x1b[38;2;96;115;138m└' + bar + '┘\x1b[0m\r\n$ ',
  ].join('\r\n');
  timedWrite(out);
  term.focus();
}

function writeUnicode(): void {
  timedWrite(
    '\r\nCJK wide:   日本語テキスト · 中文终端渲染 · 한국어 터미널\r\n' +
    'Accents:    café résumé naïve über — αβγδε λμΩ ∑∏√\r\n' +
    'Box glyphs: ┌──┬──┐ ╔══╦══╗ ╰──╯ ▓▒░\r\n' +
    'OSC 8 link: \x1b]8;;https://termlab.coey.dev/\x07termlab.coey.dev\x1b]8;;\x07 · \x1b]8;;https://github.com/acoyfellow/cloudterm\x07github.com/acoyfellow/cloudterm\x1b]8;;\x07\r\n$ ',
  );
  term.focus();
}

function writeBurst(): void {
  const parts: string[] = ['\r\n'];
  const stamp = new Date().toISOString();
  for (let i = 0; i < 10000; i++) {
    parts.push(`line ${i} \x1b[36m${stamp}\x1b[0m\r\n`);
  }
  parts.push('$ ');
  timedWrite(parts.join(''));
  term.focus();
}

(document.getElementById('write-sample') as HTMLButtonElement).onclick = writeSample;
(document.getElementById('write-colors') as HTMLButtonElement).onclick = writeColors;
(document.getElementById('write-256') as HTMLButtonElement).onclick = write256;
(document.getElementById('write-tui') as HTMLButtonElement).onclick = writeTui;
(document.getElementById('write-unicode') as HTMLButtonElement).onclick = writeUnicode;
(document.getElementById('write-burst') as HTMLButtonElement).onclick = writeBurst;
(document.getElementById('clear') as HTMLButtonElement).onclick = () => {
  lineBuf = '';
  timedWrite('\x1b[2J\x1b[H$ ');
  term.focus();
};

searchInput.addEventListener('input', () => {
  const q = searchInput.value;
  if (!q) term.clearSearch();
  else term.findNext(q);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && searchInput.value) {
    if (e.shiftKey) term.findPrevious(searchInput.value);
    else term.findNext(searchInput.value);
  }
});

toggleXray.onclick = () => {
  const off = stage.classList.toggle('no-xray');
  toggleXray.classList.toggle('active', !off);
  toggleXray.setAttribute('aria-pressed', String(!off));
  requestAnimationFrame(() => term.fit());
};

timedWrite(
  '\x1b[1;38;2;243;128;32mcloudterm\x1b[0m \x1b[1mv0.0.17\x1b[0m — tiny DOM-rendered terminal on @chenglou/pretext\r\n' +
  'Real selectable DOM text · 16 KB gz · 0 WASM · 11/11 agent innerText\r\n' +
  'Type \x1b[1mhelp\x1b[0m, \x1b[1mquery\x1b[0m, \x1b[1mtui\x1b[0m, or click any payload above. Try Cmd+F on this text.\r\n\r\n$ ',
);

term.focus();
