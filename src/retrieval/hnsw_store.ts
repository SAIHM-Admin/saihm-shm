import type { DenseHit, VectorStore } from "./vector_store.js";

export interface HnswParams {
  readonly m: number;
  readonly efConstruction: number;
  readonly efSearch: number;
  readonly seed: number;
}

export const DEFAULT_HNSW: HnswParams = { m: 24, efConstruction: 200, efSearch: 128, seed: 0x9e3779b1 };

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Cand {
  d: number;
  id: number;
}

class Heap {
  private readonly a: Cand[] = [];
  constructor(private readonly min: boolean) {}
  get size(): number {
    return this.a.length;
  }
  peek(): Cand {
    return this.a[0]!;
  }
  private above(x: Cand, y: Cand): boolean {
    return this.min ? x.d < y.d : x.d > y.d;
  }
  push(c: Cand): void {
    const a = this.a;
    a.push(c);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.above(a[i]!, a[p]!)) {
        [a[i], a[p]] = [a[p]!, a[i]!];
        i = p;
      } else break;
    }
  }
  pop(): Cand {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < a.length && this.above(a[l]!, a[best]!)) best = l;
        if (r < a.length && this.above(a[r]!, a[best]!)) best = r;
        if (best === i) break;
        [a[i], a[best]] = [a[best]!, a[i]!];
        i = best;
      }
    }
    return top;
  }
}

export class HnswStore implements VectorStore {
  readonly dim: number;
  private readonly params: HnswParams;
  private readonly rng: () => number;
  private readonly mL: number;

  private readonly vectors: (Float32Array | null)[] = [];
  private readonly links: number[][][] = [];
  private readonly nodeLayer: number[] = [];
  private readonly deleted: boolean[] = [];
  private entryPoint = -1;
  private topLayer = -1;
  private live = 0;

  constructor(
    dim: number,
    items: readonly { readonly id: number; readonly vec: Float32Array }[],
    params: Partial<HnswParams> = {},
  ) {
    this.dim = dim;
    this.params = { ...DEFAULT_HNSW, ...params };
    if (this.params.m < 1) throw new Error(`HnswStore: m must be >= 1 (got ${this.params.m})`);
    this.rng = mulberry32(this.params.seed);
    this.mL = 1 / Math.log(this.params.m);
    for (let expected = 0; expected < items.length; expected++) {
      const it = items[expected]!;
      if (it.id !== expected) {
        throw new Error(`HnswStore: expects contiguous ids 0..n-1; got id ${it.id} at position ${expected}`);
      }
      if (it.vec.length !== dim) {
        throw new Error(`HnswStore: vector for id ${it.id} has dim ${it.vec.length}, store dim ${dim} (fail-closed)`);
      }
      this.insert(it.id, it.vec);
    }
  }

  get size(): number {
    return this.live;
  }

  private mMax(layer: number): number {
    return layer === 0 ? this.params.m * 2 : this.params.m;
  }

  private dist(q: Float32Array, id: number): number {
    const v = this.vectors[id]!;
    let s = 0;
    for (let i = 0; i < v.length; i++) s += q[i]! * v[i]!;
    return 1 - s;
  }

  private insert(id: number, vec: Float32Array): void {
    const layer = Math.floor(-Math.log(this.rng() || Number.MIN_VALUE) * this.mL);
    this.vectors[id] = vec;
    this.nodeLayer[id] = layer;
    this.deleted[id] = false;
    const perLayer: number[][] = [];
    for (let l = 0; l <= layer; l++) perLayer.push([]);
    this.links[id] = perLayer;
    this.live++;

    if (this.entryPoint === -1) {
      this.entryPoint = id;
      this.topLayer = layer;
      return;
    }

    let ep = this.entryPoint;
    for (let lc = this.topLayer; lc > layer; lc--) {
      ep = this.greedyNearest(vec, ep, lc);
    }
    let curEp: number[] = [ep];
    for (let lc = Math.min(this.topLayer, layer); lc >= 0; lc--) {
      const W = this.searchLayer(vec, curEp, this.params.efConstruction, lc);
      const neighbors = this.selectNeighbors(vec, W, this.params.m);
      for (const n of neighbors) {
        this.links[id]![lc]!.push(n);
        this.links[n]![lc]!.push(id);
        const cap = this.mMax(lc);
        const nl = this.links[n]![lc]!;
        if (nl.length > cap) {
          const cands = nl.map((x) => ({ d: this.dist(this.vectors[n]!, x), id: x }));
          this.links[n]![lc] = this.selectNeighbors(this.vectors[n]!, cands, cap);
        }
      }
      curEp = W.map((c) => c.id);
    }
    if (layer > this.topLayer) {
      this.entryPoint = id;
      this.topLayer = layer;
    }
  }

  private greedyNearest(q: Float32Array, entry: number, layer: number): number {
    let cur = entry;
    let curD = this.deleted[cur] ? Infinity : this.dist(q, cur);
    for (;;) {
      let changed = false;
      for (const n of this.links[cur]?.[layer] ?? []) {
        if (this.deleted[n]) continue;
        const d = this.dist(q, n);
        if (d < curD) {
          curD = d;
          cur = n;
          changed = true;
        }
      }
      if (!changed) return cur;
    }
  }

  private searchLayer(q: Float32Array, entryPoints: number[], ef: number, layer: number): Cand[] {
    const visited = new Set<number>();
    const candidates = new Heap(true);
    const result = new Heap(false);
    for (const e of entryPoints) {
      if (this.deleted[e]) continue;
      const d = this.dist(q, e);
      candidates.push({ d, id: e });
      result.push({ d, id: e });
      visited.add(e);
    }
    while (result.size > ef) result.pop();

    while (candidates.size > 0) {
      const c = candidates.pop();
      if (result.size >= ef && c.d > result.peek().d) break;
      for (const n of this.links[c.id]?.[layer] ?? []) {
        if (visited.has(n)) continue;
        visited.add(n);
        if (this.deleted[n]) continue;
        const d = this.dist(q, n);
        if (result.size < ef || d < result.peek().d) {
          candidates.push({ d, id: n });
          result.push({ d, id: n });
          if (result.size > ef) result.pop();
        }
      }
    }
    const out: Cand[] = [];
    while (result.size > 0) out.push(result.pop());
    out.reverse();
    return out;
  }

  private selectNeighbors(q: Float32Array, candidates: Cand[], m: number): number[] {
    const sorted = [...candidates].sort((a, b) => a.d - b.d);
    const kept: Cand[] = [];
    const deferred: Cand[] = [];
    for (const c of sorted) {
      if (kept.length >= m) break;
      let good = true;
      for (const k of kept) {
        if (this.distBetween(c.id, k.id) < c.d) {
          good = false;
          break;
        }
      }
      if (good) kept.push(c);
      else deferred.push(c);
    }
    for (const c of deferred) {
      if (kept.length >= m) break;
      kept.push(c);
    }
    return kept.map((c) => c.id);
  }

  private distBetween(a: number, b: number): number {
    const va = this.vectors[a]!;
    const vb = this.vectors[b]!;
    let s = 0;
    for (let i = 0; i < va.length; i++) s += va[i]! * vb[i]!;
    return 1 - s;
  }

  query(qv: Float32Array, limit: number): DenseHit[] {
    if (qv.length !== this.dim) {
      throw new Error(`HnswStore: query dim ${qv.length} != store dim ${this.dim} (fail-closed)`);
    }
    if (this.live === 0 || this.entryPoint === -1) return [];
    const want = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : this.live;
    const ef = Math.max(this.params.efSearch, want);

    let ep = this.entryPoint;
    for (let lc = this.topLayer; lc > 0; lc--) ep = this.greedyNearest(qv, ep, lc);
    const found = this.searchLayer(qv, [ep], ef, 0);
    const hits: DenseHit[] = [];
    for (let i = 0; i < found.length && hits.length < want; i++) {
      hits.push({ id: found[i]!.id, score: 1 - found[i]!.d });
    }
    return hits;
  }

  remove(id: number): boolean {
    const v = this.vectors[id];
    if (v == null || this.deleted[id]) return false;
    v.fill(0);
    this.vectors[id] = null;
    this.deleted[id] = true;
    this.live--;
    if (id === this.entryPoint) this.reassignEntry();
    return true;
  }

  private reassignEntry(): void {
    let best = -1;
    let bestLayer = -1;
    for (let i = 0; i < this.vectors.length; i++) {
      if (this.deleted[i] || this.vectors[i] == null) continue;
      if (this.nodeLayer[i]! > bestLayer) {
        bestLayer = this.nodeLayer[i]!;
        best = i;
      }
    }
    this.entryPoint = best;
    this.topLayer = bestLayer;
  }
}
