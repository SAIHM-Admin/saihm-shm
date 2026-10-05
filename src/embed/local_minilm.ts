import type { Embedder, EmbedResult } from "./types.js";

export class LocalMiniLmEmbedder implements Embedder {
  readonly modelId = "Xenova/all-MiniLM-L6-v2";
  readonly dim = 384;
  private extractor: ((texts: string[], opts: unknown) => Promise<unknown>) | null = null;

  private async pipe(): Promise<(texts: string[], opts: unknown) => Promise<unknown>> {
    if (this.extractor) return this.extractor;
    const { pipeline } = await import("@xenova/transformers");
    const extractor = await pipeline("feature-extraction", this.modelId);
    this.extractor = extractor as unknown as (texts: string[], opts: unknown) => Promise<unknown>;
    return this.extractor;
  }

  async embed(texts: readonly string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], modelId: this.modelId, dim: this.dim };
    const extractor = await this.pipe();
    const vectors: Float32Array[] = [];
    for (const text of texts) {
      const out = (await extractor([text], { pooling: "mean", normalize: true })) as {
        tolist(): number[][];
      };
      const rows = out.tolist();
      const row = rows[0];
      if (rows.length !== 1 || !row) {
        throw new Error(
          `local_minilm: expected exactly 1 row for 1 input, got ${rows.length} (model=${this.modelId})`,
        );
      }
      vectors.push(Float32Array.from(row));
    }
    const dim = vectors[0]?.length ?? this.dim;
    return { vectors, modelId: this.modelId, dim };
  }
}
