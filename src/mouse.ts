export type MouseTrackingMode = 0 | 9 | 1000 | 1002 | 1003;

export interface MouseEventData {
  kind: 'press' | 'release' | 'move' | 'wheel';
  button: 0 | 1 | 2 | 3;
  col: number;
  row: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  wheelUp?: boolean;
}

export interface MouseMode {
  tracking: MouseTrackingMode;
  sgr: boolean;
}

export interface MouseCoordinates {
  clientX: number;
  clientY: number;
  rect: { left: number; top: number };
  charWidth: number;
  lineHeight: number;
  scrollTop: number;
  screenTop: number;
}

export function mapMouseCoordinates(input: MouseCoordinates): { col: number; row: number } {
  return {
    col: Math.floor((input.clientX - input.rect.left) / input.charWidth) + 1,
    row: Math.floor((input.clientY - input.rect.top + input.scrollTop - input.screenTop) / input.lineHeight) + 1,
  };
}

export function encodeMouse(ev: MouseEventData, mode: MouseMode): string | null {
  if (!shouldReport(ev, mode.tracking)) return null;
  if (!mode.sgr && (ev.col > 223 || ev.row > 223 || ev.col < 1 || ev.row < 1)) return null;
  const code = buttonCode(ev) + modifierCode(ev);
  if (mode.sgr) return `\x1b[<${code};${ev.col};${ev.row}${ev.kind === 'release' ? 'm' : 'M'}`;
  const legacyCode = ev.kind === 'release' ? 3 + modifierCode(ev) : code;
  return `\x1b[M${String.fromCharCode(legacyCode + 32, ev.col + 32, ev.row + 32)}`;
}

function shouldReport(ev: MouseEventData, tracking: MouseTrackingMode): boolean {
  if (tracking === 0) return false;
  if (ev.kind === 'press' || ev.kind === 'wheel') return true;
  if (ev.kind === 'release') return tracking !== 9;
  return tracking === 1003 || (tracking === 1002 && ev.button !== 3);
}

function buttonCode(ev: MouseEventData): number {
  if (ev.kind === 'wheel') return ev.wheelUp ? 64 : 65;
  return ev.button + (ev.kind === 'move' ? 32 : 0);
}

function modifierCode(ev: MouseEventData): number {
  return (ev.shift ? 4 : 0) + (ev.alt ? 8 : 0) + (ev.ctrl ? 16 : 0);
}
