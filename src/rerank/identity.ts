import type { Reranker, RerankCandidate } from "./types.js";

export class IdentityReranker implements Reranker {
  readonly modelId = "identity";

  async score(_query: string, candidates: readonly RerankCandidate[]): Promise<number[]> {
    return candidates.map((_, i) => -i);
  }
}
