const zeroWidth = /^[\p{Mn}\p{Me}\u200b-\u200f\ufe00-\ufe0f]/u;

const wideRanges = [
  0x1100, 0x115f, 0x2e80, 0xa4cf, 0xac00, 0xd7a3, 0xf900, 0xfaff,
  0xfe30, 0xfe4f, 0xff00, 0xff60, 0xffe0, 0xffe6, 0x1f300, 0x1f64f,
  0x1f900, 0x1f9ff, 0x20000, 0x3fffd,
];

function inRanges(code: number, ranges: number[]): boolean {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = ranges[middle * 2]!;
    const end = ranges[middle * 2 + 1]!;
    if (code < start) high = middle - 1;
    else if (code > end) low = middle + 1;
    else return true;
  }
  return false;
}

export function wcwidth(ch: string): 0 | 1 | 2 {
  const code = ch.codePointAt(0);
  if (code === undefined) return 0;
  if (code < 0x0300) return 1;
  if (zeroWidth.test(ch)) return 0;
  return inRanges(code, wideRanges) ? 2 : 1;
}
