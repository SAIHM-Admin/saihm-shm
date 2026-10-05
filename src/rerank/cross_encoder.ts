import type { Reranker, RerankCandidate } from "./types.js";

type Tokenizer = (text: string[], opts: unknown) => unknown;
type SeqModel = (inputs: unknown) => Promise<{ logits: { tolist(): number[][] } }>;

export interface CrossEncoderConfig {
  readonly batchSize?: number;
}

export class CrossEncoderReranker implements Reranker {
  readonly modelId = "Xenova/ms-marco-MiniLM-L-6-v2";
  private readonly batchSize: number;
  private tok: Tokenizer | null = null;
  private model: SeqModel | null = null;

  constructor(cfg: CrossEncoderConfig = {}) {
    this.batchSize =
      Number.isFinite(cfg.batchSize) && (cfg.batchSize as number) >= 1
        ? Math.floor(cfg.batchSize as number)
        : 32;
  }

  private async load(): Promise<{ tokenizer: Tokenizer; model: SeqModel }> {
    if (this.tok && this.model) return { tokenizer: this.tok, model: this.model };
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@xenova/transformers");
    const tokenizer = await AutoTokenizer.from_pretrained(this.modelId);
    const model = await AutoModelForSequenceClassification.from_pretrained(this.modelId);
    this.tok = tokenizer as unknown as Tokenizer;
    this.model = model as unknown as SeqModel;
    return { tokenizer: this.tok, model: this.model };
  }

  async score(query: string, candidates: readonly RerankCandidate[]): Promise<number[]> {
    if (candidates.length === 0) return [];
    const { tokenizer, model } = await this.load();
    const scores: number[] = [];
    for (let i = 0; i < candidates.length; i += this.batchSize) {
      const batch = candidates.slice(i, i + this.batchSize);
      const inputs = tokenizer(
        batch.map(() => query),
        { text_pair: batch.map((c) => c.text), padding: true, truncation: true },
      );
      const { logits } = await model(inputs);
      const rows = logits.tolist();
      for (const row of rows) {
        const logit = row[0];
        scores.push(typeof logit === "number" && Number.isFinite(logit) ? logit : Number.NEGATIVE_INFINITY);
      }
    }
    return scores;
  }
}
