import type { RankRetriever, ScoredHit } from "../answer/answer_layer.js";
import { withPool, type SelectOpts } from "../retrieval/scope.js";
import type { Reranker } from "./types.js";
import type { LabelLookup } from "./reranking_retriever.js";
import { DEFAULT_RERANK } from "./reranking_retriever.js";
import type { RankedHit } from "../retrieval/semantic.js";
import { SessionClosedError } from "../retrieval/session_closed.js";

export type PoolTextSource = (cellIds: readonly string[]) => Promise<Map<string, string>>;

export class RerankingRankRetriever implements RankRetriever {
  private readonly rerankK: number;
  private readonly textOf: PoolTextSource | undefined;
  private readonly onFallback: ((err: unknown) => void) | undefined;
  private attempts = 0;
  private fallbacks = 0;

  constructor(
    private readonly base: RankRetriever,
    private readonly reranker: Reranker,
    private readonly labelOf: LabelLookup,
    cfg: { rerankK?: number; textOf?: PoolTextSource; onFallback?: (err: unknown) => void } = {},
  ) {
    this.rerankK =
      Number.isFinite(cfg.rerankK) && (cfg.rerankK as number) >= 1
        ? Math.floor(cfg.rerankK as number)
        : DEFAULT_RERANK.rerankK;
    this.textOf = cfg.textOf;
    this.onFallback = cfg.onFallback;
  }

  get stats(): { readonly attempts: number; readonly fallbacks: number } {
    return { attempts: this.attempts, fallbacks: this.fallbacks };
  }

  private notifyFallback(err: unknown): void {
    try {
      this.onFallback?.(err);
    } catch {
    }
  }

  private async candidateTexts(pool: string[]): Promise<{ cellId: string; text: string }[]> {
    if (!this.textOf) return pool.map((cellId) => ({ cellId, text: this.labelOf(cellId) ?? "" }));
    const byId = await this.textOf(pool);
    return pool.map((cellId) => ({ cellId, text: byId.get(cellId) ?? this.labelOf(cellId) ?? "" }));
  }

  private static coerce(raw: number | undefined): number {
    return typeof raw === "number" && Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY;
  }

  private async rankPool(query: string, pool: string[]): Promise<ScoredHit[]> {
    const candidates = await this.candidateTexts(pool);
    const scores = await this.reranker.score(query, candidates);
    return pool
      .map((cellId, i) => ({ cellId, s: RerankingRankRetriever.coerce(scores[i]), i }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((o) => ({ cellId: o.cellId, score: o.s }));
  }

  async select(query: string, opts?: SelectOpts): Promise<string[]> {
    const maxK = opts?.maxK;
    const poolK = Math.max(this.rerankK, maxK ?? this.rerankK);
    const pool = await this.base.select(query, withPool(opts, poolK));
    const bound = (ids: string[]) => (maxK !== undefined ? ids.slice(0, maxK) : ids);
    if (pool.length <= 1) return bound(pool);
    this.attempts++;
    try {
      return bound((await this.rankPool(query, pool)).map((h) => h.cellId));
    } catch (err) {
      if (err instanceof SessionClosedError) throw err;
      this.fallbacks++;
      this.notifyFallback(err);
      return bound(pool);
    }
  }

  async selectDetailed(query: string, opts?: SelectOpts): Promise<readonly RankedHit[]> {
    const baseFn = this.base.selectDetailed;
    if (baseFn === undefined) {
      throw new Error(
        "reranker: base retriever does not expose selectDetailed — match provenance is unavailable " +
          "through this chain (fail-closed; a hit without `matched` would read as 'no lists matched')",
      );
    }
    const maxK = opts?.maxK;
    const poolK = Math.max(this.rerankK, maxK ?? this.rerankK);
    const pool = await baseFn.call(this.base, query, withPool(opts, poolK));
    const bound = (hs: readonly RankedHit[]) => (maxK !== undefined ? hs.slice(0, maxK) : hs);
    if (pool.length <= 1) return bound(pool);
    this.attempts++;
    try {
      const order = await this.rankPool(
        query,
        pool.map((h) => h.cellId),
      );
      const byId = new Map(pool.map((h) => [h.cellId, h]));
      return bound(order.map((o) => byId.get(o.cellId)!));
    } catch (err) {
      if (err instanceof SessionClosedError) throw err;
      this.fallbacks++;
      this.notifyFallback(err);
      return bound(pool);
    }
  }

  async selectScored(query: string, opts?: SelectOpts): Promise<readonly ScoredHit[]> {
    const maxK = opts?.maxK;
    const poolK = Math.max(this.rerankK, maxK ?? this.rerankK);
    const pool = await this.base.select(query, withPool(opts, poolK));
    if (pool.length === 0) return [];
    const bound = (hits: ScoredHit[]) => (maxK !== undefined ? hits.slice(0, maxK) : hits);
    this.attempts++;
    try {
      return bound(await this.rankPool(query, pool));
    } catch (err) {
      if (err instanceof SessionClosedError) throw err;
      this.fallbacks++;
      this.notifyFallback(err);
      return bound(pool.map((cellId) => ({ cellId, score: Number.POSITIVE_INFINITY })));
    }
  }
}
