import type { IndexEntry, RecalledBody, SaihmReadPort } from "../saihm_client/types.js";
import { mapWithConcurrency } from "../util/concurrency.js";
import type { BodyFetchHint, BodySource } from "./types.js";

export interface SaihmBodySourceConfig {
  readonly recallTimeoutMs?: number;
  readonly recallConcurrency?: number;
}

const DEFAULT_RECALL_CONCURRENCY = 4;

export class SaihmBodySource implements BodySource {
  private index: Map<string, IndexEntry> | undefined;
  private forgotten: Set<string> | undefined;
  private readonly erased = new Set<string>();
  private readonly concurrency: number;
  private recallFailures = 0;
  private tier3Fallbacks = 0;

  constructor(
    private readonly port: SaihmReadPort,
    private readonly cfg: SaihmBodySourceConfig = {},
  ) {
    const rc = cfg.recallConcurrency;
    this.concurrency =
      typeof rc === "number" && Number.isInteger(rc) && rc >= 1 ? rc : DEFAULT_RECALL_CONCURRENCY;
  }

  forget(cellId: string): void {
    this.erased.add(cellId);
    this.index?.delete(cellId);
    this.forgotten?.add(cellId);
  }

  async fetchByIds(cellIds: readonly string[], hint?: BodyFetchHint): Promise<RecalledBody[]> {
    const idx = await this.ensureIndex();
    const found = new Map<string, RecalledBody>();
    const want = new Set(cellIds.filter((id) => !this.forgotten!.has(id)));

    const q = hint?.query?.trim();
    if (q) {
      for (const b of await this.safeRecall(q)) {
        if (want.has(b.cellId) && !found.has(b.cellId)) found.set(b.cellId, b);
      }
    }

    const misses = [...want].filter((id) => !found.has(id));
    const recalled = await mapWithConcurrency(misses, this.concurrency, async (id) => {
      const label = idx.get(id)?.label?.trim();
      if (!label) return undefined;
      return (await this.safeRecall(label)).find((b) => b.cellId === id);
    });
    for (let i = 0; i < misses.length; i++) {
      const hit = recalled[i];
      if (hit) found.set(misses[i]!, hit);
    }

    for (const id of want) {
      if (found.has(id)) continue;
      const e = idx.get(id);
      if (!e || !e.label) continue;
      found.set(id, { cellId: id, plaintext: e.label, epoch: e.epoch, tier: e.tier, partial: true });
      this.tier3Fallbacks++;
    }

    return cellIds.map((id) => found.get(id)).filter((b): b is RecalledBody => b !== undefined);
  }

  invalidate(): void {
    this.index = undefined;
    this.forgotten = undefined;
  }

  private async ensureIndex(): Promise<Map<string, IndexEntry>> {
    if (!this.index) {
      const entries = await this.port.readIndex();
      this.index = new Map(entries.filter((e) => !e.forgotten).map((e) => [e.cellId, e]));
      this.forgotten = new Set(entries.filter((e) => e.forgotten).map((e) => e.cellId));
      for (const id of this.erased) {
        this.index.delete(id);
        this.forgotten.add(id);
      }
    }
    return this.index;
  }

  private async safeRecall(query: string): Promise<RecalledBody[]> {
    try {
      const opts =
        this.cfg.recallTimeoutMs !== undefined ? { timeoutMs: this.cfg.recallTimeoutMs } : undefined;
      return await this.port.recallByQuery(query, opts);
    } catch {
      this.recallFailures++;
      return [];
    }
  }

  get stats(): { recallFailures: number; tier3Fallbacks: number } {
    return { recallFailures: this.recallFailures, tier3Fallbacks: this.tier3Fallbacks };
  }
}
