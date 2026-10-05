import { mapWithConcurrency } from "../util/concurrency.js";
import { IgnoredParameterError, type OwnCellRead, type RecalledBody } from "../saihm_client/types.js";
import type { BodyFetchHint, BodySource } from "./types.js";

export interface OwnCellReader {
  recallOwn(cellId: string): Promise<{ readonly found: OwnCellRead | null }>;
}

export interface OwnCellBodyStats {
  readonly marked: number;
  readonly found: number;
  readonly notFound: number;
  readonly failures: number;
  readonly stopped: string | null;
}

export const DEFAULT_OWN_READ_CONCURRENCY = 4;

export class OwnCellBodySource implements BodySource {
  private readonly marked = new Set<string>();
  private readonly erased = new Set<string>();
  private readonly concurrency: number;
  private found = 0;
  private notFound = 0;
  private failures = 0;
  private stopped: string | null = null;

  constructor(
    private readonly inner: BodySource,
    private readonly reader: OwnCellReader,
    cfg: { readonly concurrency?: number } = {},
  ) {
    const c = cfg.concurrency;
    this.concurrency = typeof c === "number" && Number.isInteger(c) && c >= 1 ? c : DEFAULT_OWN_READ_CONCURRENCY;
  }

  supersede(cellId: string): void {
    if (!this.erased.has(cellId)) this.marked.add(cellId);
  }

  forget(cellId: string): void {
    this.erased.add(cellId);
    this.marked.delete(cellId);
  }

  async fetchByIds(cellIds: readonly string[], hint?: BodyFetchHint): Promise<RecalledBody[]> {
    const got = new Map<string, RecalledBody>();
    const byId = this.stopped !== null ? [] : [...new Set(cellIds)].filter((id) => this.marked.has(id));
    if (byId.length > 0) {
      const answers = await mapWithConcurrency(byId, this.concurrency, async (id): Promise<RecalledBody | undefined> => {
        try {
          const r = await this.reader.recallOwn(id);
          if (r.found === null || r.found.cellId !== id) {
            this.notFound++;
            return undefined;
          }
          this.found++;
          return { cellId: id, plaintext: r.found.plaintext, epoch: 0, tier: "saihm", seq: r.found.seq };
        } catch (e) {
          this.failures++;
          if (e instanceof IgnoredParameterError) this.stopped ??= `${e.parameter} was not applied: ${e.message}`;
          return undefined;
        }
      });
      byId.forEach((id, i) => {
        const b = answers[i];
        if (b !== undefined && !this.erased.has(id)) got.set(id, b);
      });
    }
    const rest = [...new Set(cellIds)].filter((id) => !got.has(id));
    if (rest.length > 0) for (const b of await this.inner.fetchByIds(rest, hint)) if (!got.has(b.cellId)) got.set(b.cellId, b);
    return cellIds.map((id) => got.get(id)).filter((b): b is RecalledBody => b !== undefined);
  }

  get stats(): OwnCellBodyStats {
    return { marked: this.marked.size, found: this.found, notFound: this.notFound, failures: this.failures, stopped: this.stopped };
  }
}
