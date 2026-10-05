export interface EmbedResult {
  readonly vectors: readonly Float32Array[];
  readonly modelId: string;
  readonly dim: number;
}

export interface Embedder {
  readonly modelId: string;
  readonly dim: number;
  embed(texts: readonly string[]): Promise<EmbedResult>;
}

export interface EmbeddedVector {
  readonly vector: Float32Array;
  readonly modelId: string;
  readonly dim: number;
}

export interface Embeddable {
  readonly text: string;
  readonly namespace: string;
}

export interface SensitivityConfig {
  readonly allowRemoteNamespaces?: ReadonlySet<string>;
}
