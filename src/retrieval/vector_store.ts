export interface DenseHit {
  readonly id: number;
  readonly score: number;
}

export interface VectorStore {
  readonly dim: number;
  readonly size: number;
  query(qv: Float32Array, limit: number): DenseHit[];
  remove(id: number): boolean;
}

export class FlatStore implements VectorStore {
  readonly dim: number;
  private readonly vecs = new Map<number, Float32Array>();

  constructor(
    dim: number,
    items: readonly { readonly id: number; readonly vec: Float32Array }[],
  ) {
    this.dim = dim;
    for (const { id, vec } of items) {
      if (vec.length !== dim) {
        throw new Error(
          `FlatStore: vector for id ${id} has dim ${vec.length}, store dim ${dim} (fail-closed)`,
        );
      }
      this.vecs.set(id, vec);
    }
  }

  get size(): number {
    return this.vecs.size;
  }

  query(qv: Float32Array, limit: number): DenseHit[] {
    if (qv.length !== this.dim) {
      throw new Error(
        `FlatStore: query dim ${qv.length} != store dim ${this.dim} (fail-closed)`,
      );
    }
    const hits: DenseHit[] = [];
    for (const [id, vec] of this.vecs) {
      let s = 0;
      for (let i = 0; i < vec.length; i++) s += qv[i]! * vec[i]!;
      hits.push({ id, score: s });
    }
    if (limit >= hits.length) return hits;
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  remove(id: number): boolean {
    const vec = this.vecs.get(id);
    if (!vec) return false;
    vec.fill(0);
    this.vecs.delete(id);
    return true;
  }
}
