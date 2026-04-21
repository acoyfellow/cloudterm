// Speculative local echo. Overlay prediction, not reconciled grid.
//
// A PredictionBuffer is a small FIFO of glyph+cursor predictions the client
// paints on top of the authoritative grid while waiting for the server's
// echo. When authoritative output arrives, the oldest matching prediction is
// dropped. Contradictions or staleness drop the whole buffer: better to let
// the authoritative paint win than keep showing guesses that diverged from
// reality.
//
// Design references Mosh's state-synchronization prediction, simplified:
// we never reconcile against a predicted grid, we just overlay. The Grid is
// untouched.

export type Prediction =
  | { kind: 'print'; row: number; col: number; ch: string; at: number }
  | { kind: 'cursor'; row: number; col: number; at: number };

export interface PredictionBufferOpts {
  ttlMs?: number;
}

export class PredictionBuffer {
  // Active predictions in insertion order. Most ops walk this list linearly;
  // it stays small (bounded by in-flight keystrokes, usually 0-3).
  private items: Prediction[] = [];
  private readonly ttlMs: number;

  constructor(opts: PredictionBufferOpts = {}) {
    this.ttlMs = opts.ttlMs ?? 500;
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    if (this.items.length) this.items = [];
  }

  push(p: Prediction): void {
    this.items.push(p);
  }

  iter(): Iterable<Prediction> {
    return this.items;
  }

  // Called on grid print. Compares against the oldest 'print' prediction.
  // - match (row, col, ch): drop that prediction, keep the rest.
  // - same (row, col) but different ch: server disagreed about content,
  //   drop everything.
  // - different (row, col): server is writing somewhere unexpected, drop
  //   everything.
  // - no print predictions: no-op.
  onGridPrint(row: number, col: number, ch: string): void {
    const idx = this.findFirst('print');
    if (idx === -1) return;
    const p = this.items[idx] as Extract<Prediction, { kind: 'print' }>;
    if (p.row === row && p.col === col && p.ch === ch) {
      this.items.splice(idx, 1);
      return;
    }
    if (p.row === row && p.col === col) {
      this.clear();
      return;
    }
    this.clear();
  }

  // Called on grid cursor move. If the oldest cursor prediction matches the
  // observed position, drop it. Otherwise drop everything: the server took
  // the cursor somewhere we did not predict.
  onGridCursor(row: number, col: number): void {
    const idx = this.findFirst('cursor');
    if (idx === -1) return;
    const p = this.items[idx] as Extract<Prediction, { kind: 'cursor' }>;
    if (p.row === row && p.col === col) {
      this.items.splice(idx, 1);
      return;
    }
    this.clear();
  }

  // Drop anything older than ttlMs. If an item times out, drop it and
  // everything before it: the earlier history is obviously stale too.
  prune(now: number): void {
    if (!this.items.length) return;
    let cut = -1;
    for (let i = 0; i < this.items.length; i++) {
      if (now - this.items[i]!.at > this.ttlMs) cut = i;
      else break;
    }
    if (cut >= 0) this.items.splice(0, cut + 1);
  }

  private findFirst(kind: Prediction['kind']): number {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i]!.kind === kind) return i;
    }
    return -1;
  }
}
