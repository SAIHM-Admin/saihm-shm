import type { Reranker } from "./types.js";

export interface RankedSource {
  readonly name: string;
  retrieve(query: string, k: number): Promise<string[]>;
}

export type LabelLookup = (cellId: string) => string | undefined;

export interface RerankConfig {
  readonly rerankK: number;
}

export const DEFAULT_RERANK: RerankConfig = { rerankK: 30 };

export class RerankingRetriever implements RankedSource {
  readonly name: string;
  private readonly rerankK: number;

  constructor(
    private readonly base: RankedSource,
    private readonly reranker: Reranker,
    private readonly labelOf: LabelLookup,
    cfg: Partial<RerankConfig> = {},
  ) {
    this.rerankK =
      Number.isFinite(cfg.rerankK) && (cfg.rerankK as number) >= 1
        ? Math.floor(cfg.rerankK as number)
        : DEFAULT_RERANK.rerankK;
    this.name = `rerank(${reranker.modelId})/${base.name}`;
  }

  async retrieve(query: string, k: number): Promise<string[]> {
    const depth = Math.max(k, this.rerankK);
    const base = await this.base.retrieve(query, depth);
    if (base.length <= 1) return base;

    const poolN = Math.min(this.rerankK, base.length);
    const pool = base.slice(0, poolN);
    const candidates = pool.map((cellId) => ({ cellId, text: this.labelOf(cellId) ?? "" }));
    const scores = await this.reranker.score(query, candidates);

    const reranked = pool
      .map((cellId, i) => {
        const raw = scores[i];
        const s = typeof raw === "number" && Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY;
        return { cellId, s, i };
      })
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((o) => o.cellId);

    return [...reranked, ...base.slice(poolN)];
  }
}
