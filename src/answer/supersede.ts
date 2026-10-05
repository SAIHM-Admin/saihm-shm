const DECIMAL = /^\d+$/;

export class SupersedeLedger {
  private clock = 0;
  private readonly cells = new Map<string, { readonly at: number; readonly floor: bigint | undefined }>();

  stamp(): number {
    return this.clock;
  }

  supersede(cellId: string, seq?: string): void {
    const cur = this.cells.get(cellId)?.floor;
    const v = seq !== undefined && DECIMAL.test(seq) ? BigInt(seq) : undefined;
    const floor = cur === undefined ? v : v === undefined || v < cur ? cur : v;
    this.clock++;
    this.cells.set(cellId, { at: this.clock, floor });
  }

  admits(body: { readonly cellId: string; readonly seq?: string }, since: number): boolean {
    const c = this.cells.get(body.cellId);
    if (c === undefined) return true;
    if (c.floor !== undefined && body.seq !== undefined && DECIMAL.test(body.seq)) return BigInt(body.seq) >= c.floor;
    return since >= c.at;
  }

  get size(): number {
    return this.cells.size;
  }
}
