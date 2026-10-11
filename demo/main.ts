import { mount } from '../src/index.ts';

const host = document.getElementById('term');
const sizeLabel = document.getElementById('size');
const focusState = document.getElementById('focus-state');

const term = await mount(host, {
  onData: (bytes) => {
    const s = new TextDecoder().decode(bytes);
    if (s === '\r') term.write('\r\n$ ');
    else if (s === '\x7f') term.write('\b \b');
    else term.write(s);
  },
  onResize: (cols, rows) => {
    sizeLabel.textContent = `${cols} x ${rows}`;
  },
  onTitle: (t) => {
    document.title = `cloudterm: ${t}`;
  },
});

const setFocused = (on) => {
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

term.write('\x1b[1;32mcloudterm\x1b[0m v0.0.1\r\n');
term.write('DOM-rendered terminal on @chenglou/pretext.\r\n\r\n$ ');

document.getElementById('write-sample').onclick = () => {
  term.write('\r\n\x1b]2;hello\x07');
  term.write('\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m \x1b[7mreverse\x1b[0m\r\n');
  term.write('\x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m \x1b[34mblue\x1b[0m \x1b[33myellow\x1b[0m\r\n$ ');
  term.focus();
};

document.getElementById('write-colors').onclick = () => {
  for (let i = 30; i < 38; i++) term.write(`\x1b[${i}m${i} `);
  term.write('\x1b[0m\r\n');
  for (let i = 90; i < 98; i++) term.write(`\x1b[${i}m${i} `);
  term.write('\x1b[0m\r\n$ ');
  term.focus();
};

document.getElementById('write-256').onclick = () => {
  let s = '';
  for (let i = 0; i < 256; i++) {
    s += `\x1b[48;5;${i}m ${i.toString().padStart(3, ' ')} \x1b[0m`;
    if ((i + 1) % 16 === 0) s += '\r\n';
  }
  term.write(s + '$ ');
  term.focus();
};

document.getElementById('write-burst').onclick = () => {
  let s = '';
  for (let i = 0; i < 10000; i++) {
    s += `line ${i} \x1b[36m${new Date().toISOString()}\x1b[0m\r\n`;
  }
  term.write(s + '$ ');
  term.focus();
};

document.getElementById('clear').onclick = () => {
  term.write('\x1b[2J\x1b[H$ ');
  term.focus();
};

term.focus();
