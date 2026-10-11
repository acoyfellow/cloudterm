import type { Grid, Cell } from './grid.js';
import { wcwidth } from './wcwidth.js';

export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
}

export interface SearchMatch {
  line: number;
  col: number;
  length: number;
}

interface SearchCharacter {
  text: string;
  col: number;
  width: number;
}

function characters(line: Cell[]): SearchCharacter[] {
  const result: SearchCharacter[] = [];
  for (let col = 0; col < line.length; col++) {
    const cell = line[col]!;
    if (cell.ch === '') continue;
    result.push({ text: cell.ch, col, width: Math.max(1, wcwidth(cell.ch)) });
  }
  return result;
}

export function searchGrid(grid: Grid, query: string, options: SearchOptions = {}): SearchMatch[] {
  if (!query) return [];
  let expression: RegExp;
  try {
    expression = options.regex
      ? new RegExp(query, `g${options.caseSensitive ? '' : 'i'}u`)
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), `g${options.caseSensitive ? '' : 'i'}u`);
  } catch {
    return [];
  }
  const matches: SearchMatch[] = [];
  for (let lineIndex = grid.trimmed; lineIndex < grid.trimmed + grid.totalLines(); lineIndex++) {
    const chars = characters(grid.getLine(lineIndex));
    const text = chars.map((character) => character.text).join('');
    const offsets: number[] = [];
    let offset = 0;
    for (const character of chars) {
      offsets.push(offset);
      offset += character.text.length;
    }
    for (let match; (match = expression.exec(text)) !== null;) {
      if (!match[0]) { expression.lastIndex += 1; continue; }
      const start = offsets.findIndex((value) => value === match.index);
      const end = offsets.reduce((last, value, index) => value < match.index + match[0].length ? index : last, -1);
      if (start >= 0 && end >= 0) {
        const first = chars[start]!;
        const last = chars[end]!;
        matches.push({ line: lineIndex, col: first.col, length: last.col + last.width - first.col });
      }
    }
  }
  return matches;
}
