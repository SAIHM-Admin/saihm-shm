import type { Embeddable, EmbeddedVector, Embedder, SensitivityConfig } from "./types.js";

export class SensitivityRouter {
  private readonly local: Embedder;
  private readonly remote: Embedder | undefined;
  private readonly allow: ReadonlySet<string>;

  constructor(opts: { local: Embedder; remote?: Embedder; config?: SensitivityConfig }) {
    this.local = opts.local;
    this.remote = opts.remote;
    this.allow = opts.config?.allowRemoteNamespaces ?? new Set<string>();
  }

  routesRemote(namespace: string): boolean {
    return this.remote !== undefined && this.allow.has(namespace);
  }

  async embedRecords(items: readonly Embeddable[]): Promise<EmbeddedVector[]> {
    const out: (EmbeddedVector | undefined)[] = new Array(items.length).fill(undefined);

    const localIdx: number[] = [];
    const remoteIdx: number[] = [];
    items.forEach((it, i) => (this.routesRemote(it.namespace) ? remoteIdx : localIdx).push(i));

    await this.embedGroup(items, localIdx, this.local, out);
    if (this.remote && remoteIdx.length > 0) {
      await this.embedGroup(items, remoteIdx, this.remote, out);
    }

    const result: EmbeddedVector[] = [];
    for (let i = 0; i < out.length; i++) {
      const v = out[i];
      if (!v) throw new Error(`embed routing left index ${i} unfilled (fail-closed)`);
      result.push(v);
    }
    return result;
  }

  private async embedGroup(
    items: readonly Embeddable[],
    idx: readonly number[],
    backend: Embedder,
    out: (EmbeddedVector | undefined)[],
  ): Promise<void> {
    if (idx.length === 0) return;
    const texts = idx.map((i) => items[i]!.text);
    const res = await backend.embed(texts);
    idx.forEach((origIdx, k) => {
      const vec = res.vectors[k];
      if (!vec) throw new Error("embed backend returned fewer vectors than inputs (fail-closed)");
      out[origIdx] = { vector: vec, modelId: res.modelId, dim: res.dim };
    });
  }
}

export function needsReembed(v: EmbeddedVector, target: Embedder): boolean {
  return v.modelId !== target.modelId || v.dim !== target.dim;
}
