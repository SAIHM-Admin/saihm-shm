import { CrossEncoderReranker } from "../rerank/index.js";
import type { Reranker } from "../rerank/types.js";
import type { OpenMemorySessionOptions } from "../session/index.js";

export interface ProductionProfile {
  readonly rerankK: number;
  readonly topK: number;
  readonly relevanceFloor: number;
}

export const PRODUCTION_PROFILE: ProductionProfile = {
  rerankK: 30,
  topK: 10,
  relevanceFloor: -9,
};

export function productionSessionOptions(
  overrides: { readonly reranker?: Reranker } = {},
): Pick<OpenMemorySessionOptions, "reranker" | "rerankK"> {
  return {
    reranker: overrides.reranker ?? new CrossEncoderReranker(),
    rerankK: PRODUCTION_PROFILE.rerankK,
  };
}
