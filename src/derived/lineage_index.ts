import type { BodySource } from "../answer/types.js";
import { parseDerivedCell } from "./codec.js";

export class HeaderLineageIndex {
  private readonly sources = new Map<string, readonly string[] | undefined>();
  private refreshes = 0;
  private unreadable = 0;

  constructor(private readonly bodies: BodySource) {}

  get stats(): { readonly refreshes: number; readonly unreadable: number; readonly known: number } {
    let known = 0;
    for (const v of this.sources.values()) if (v !== undefined) known++;
    return { refreshes: this.refreshes, unreadable: this.unreadable, known };
  }

  async refresh(cellIds: readonly string[]): Promise<void> {
    this.refreshes++;
    if (cellIds.length === 0) return;
    let fetched: readonly { cellId: string; plaintext: string }[] = [];
    try {
      fetched = await this.bodies.fetchByIds(cellIds);
    } catch {
      fetched = [];
    }
    const byId = new Map(fetched.map((b) => [b.cellId, b.plaintext]));
    for (const id of cellIds) {
      const body = byId.get(id);
      if (body === undefined) {
        this.sources.set(id, undefined);
        this.unreadable++;
        continue;
      }
      try {
        const item = parseDerivedCell(body);
        this.sources.set(id, item === undefined ? undefined : item.sources.map((s) => s.cellId));
      } catch {
        this.sources.set(id, undefined);
        this.unreadable++;
      }
    }
  }

  readonly lineageOf = (cellId: string): readonly string[] | undefined => this.sources.get(cellId);

  readonly forget = (cellId: string): void => {
    this.sources.delete(cellId);
  };
}
