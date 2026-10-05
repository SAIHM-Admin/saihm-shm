export interface RerankCandidate {
  readonly cellId: string;
  readonly text: string;
}

export interface Reranker {
  readonly modelId: string;
  score(query: string, candidates: readonly RerankCandidate[]): Promise<number[]>;
}
