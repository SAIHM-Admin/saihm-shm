import type { Embedder, EmbedResult } from "./types.js";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RemoteHttpConfig {
  readonly endpoint: string;
  readonly modelId: string;
  readonly dim: number;
  readonly apiKey?: string;
  readonly fetchImpl?: FetchLike;
}

export class RemoteHttpEmbedder implements Embedder {
  readonly modelId: string;
  readonly dim: number;
  private readonly cfg: RemoteHttpConfig;
  private readonly doFetch: FetchLike;

  constructor(cfg: RemoteHttpConfig) {
    this.cfg = cfg;
    this.modelId = cfg.modelId;
    this.dim = cfg.dim;
    this.doFetch = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async embed(texts: readonly string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], modelId: this.modelId, dim: this.dim };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) headers["authorization"] = `Bearer ${this.cfg.apiKey}`;

    const res = await this.doFetch(this.cfg.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: [...texts], model: this.modelId }),
    });
    if (!res.ok) throw new Error(`remote embed failed: HTTP ${res.status}`);

    const json = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
    const data = json.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error("remote embed: response shape/count mismatch (fail-closed)");
    }
    const vectors = data.map((d, i) => {
      const e = d.embedding;
      if (!Array.isArray(e) || e.length !== this.dim) {
        throw new Error(`remote embed: vector ${i} dim mismatch (expected ${this.dim})`);
      }
      return Float32Array.from(e as number[]);
    });
    return { vectors, modelId: this.modelId, dim: this.dim };
  }
}
