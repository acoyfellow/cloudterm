
interface Theme {
  background: string;
  foreground: string;
  cursor: string;
  fontFamily: string;
  fontSize: number;
}
interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
}
interface SearchMatch {
  line: number;
  col: number;
  length: number;
}
interface MountOptions {
  onData: (data: Uint8Array) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitle?: (title: string) => void;
  onCwd?: (uri: string) => void;
  onClipboard?: (text: string, selection: string) => void;
  theme?: Partial<Theme>;
  maxScrollback?: number;
  predictionMode?: 'off' | 'auto';
}
interface Terminal {
  write(data: string | Uint8Array): void;
  fit(): void;
  focus(): void;
  destroy(): void;
  search(query: string, opts?: SearchOptions): SearchMatch[];
  findNext(query: string, opts?: SearchOptions): SearchMatch | null;
  findPrevious(query: string, opts?: SearchOptions): SearchMatch | null;
  clearSearch(): void;
  serialize(): string;
  restore(data: string): void;
  readonly cols: number;
  readonly rows: number;
}
declare function mount(el: HTMLElement, opts: MountOptions): Promise<Terminal>;
export { MountOptions, type SearchMatch, type SearchOptions, Terminal, type Theme, mount };