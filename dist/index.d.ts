//#region src/renderer.d.ts

interface Theme {
  background: string;
  foreground: string;
  cursor: string;
  fontFamily: string;
  fontSize: number;
}
//#endregion
//#region src/index.d.ts
interface MountOptions {
  onData: (data: Uint8Array) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitle?: (title: string) => void;
  theme?: Partial<Theme>;
  maxScrollback?: number;
  predictionMode?: 'off' | 'auto';
}
interface Terminal {
  write(data: string | Uint8Array): void;
  fit(): void;
  focus(): void;
  destroy(): void;
  readonly cols: number;
  readonly rows: number;
}
declare function mount(el: HTMLElement, opts: MountOptions): Promise<Terminal>;
//#endregion
export { MountOptions, Terminal, type Theme, mount };