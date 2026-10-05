import type { Embedder } from "../embed/types.js";
import type { IndexEntry } from "../saihm_client/types.js";
import type { Namespace } from "../ingest/types.js";
import { parseLabel } from "../ingest/parse.js";
import { parseCurrency, type Currency } from "../retrieval/version_supersession.js";
import { BodyRedundancyIndex, DEFAULT_BODY_REDUNDANCY } from "./body_redundancy.js";
import type { BodyPair, BodyRedundancyConfig, BodyRedundancyStats } from "./body_redundancy.js";

export type ConsolidationOp = "ADD" | "UPDATE" | "MERGE" | "NOOP";

export interface ConsolidationConfig {
  readonly noopThreshold: number;
  readonly mergeThreshold: number;
}
export const DEFAULT_CONSOLIDATION: ConsolidationConfig = { noopThreshold: 0.97, mergeThreshold: 0.9 };

export interface ConsolidationDecision {
  readonly op: ConsolidationOp;
  readonly namespace: Namespace;
  readonly targets: readonly string[];
  readonly maxSim: number;
  readonly reason: string;
}

export interface RedundancyCluster {
  readonly namespace: Namespace;
  readonly cellIds: readonly string[];
  readonly minSim: number;
}

export interface DensityBracket {
  readonly labelBound: DensityStat;
  readonly bodyBound: DensityStat;
  readonly labelPairs: number;
  readonly labelConfirmed: number;
  readonly labelRefuted: number;
  readonly labelUnverifiable: number;
  readonly labelPrecision: number;
  readonly missedByLabel: readonly BodyPair[];
  readonly coverage: BodyRedundancyStats;
}

function densityFromPairs(cells: number, pairs: readonly (readonly [string, string])[]): DensityStat {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    while (r !== (parent.get(r) ?? r)) r = parent.get(r) ?? r;
    let cur = x;
    while (cur !== r) {
      const nx = parent.get(cur) ?? cur;
      parent.set(cur, r);
      cur = nx;
    }
    return r;
  };
  for (const [a, b] of pairs) {
    parent.set(a, parent.get(a) ?? a);
    parent.set(b, parent.get(b) ?? b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, number>();
  for (const id of parent.keys()) {
    const r = find(id);
    groups.set(r, (groups.get(r) ?? 0) + 1);
  }
  let clusters = 0;
  let redundantCells = 0;
  for (const size of groups.values()) {
    if (size < 2) continue;
    clusters++;
    redundantCells += size - 1;
  }
  return { cells, clusters, redundantCells, redundancyRate: cells === 0 ? 0 : redundantCells / cells };
}

export interface DensityStat {
  readonly cells: number;
  readonly clusters: number;
  readonly redundantCells: number;
  readonly redundancyRate: number;
}

interface Cell {
  readonly cellId: string;
  readonly namespace: Namespace;
  readonly cur: Currency;
  readonly vec: Float32Array;
}

function posFiniteElse(v: number | undefined, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
}

function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  if (!Number.isFinite(n) || n === 0) throw new Error("consolidator: non-normalizable embedding (fail-closed)");
  if (Math.abs(n - 1) < 1e-6) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function dominatedBy(a: Currency, b: Currency): boolean {
  if (a.version !== b.version) return a.version < b.version;
  return a.dateOrd < b.dateOrd;
}

export class Consolidator {
  private constructor(
    private readonly byNs: Map<Namespace, Cell[]>,
    private readonly embedder: Embedder,
    private readonly cfg: ConsolidationConfig,
  ) {}

  static async build(
    entries: readonly IndexEntry[],
    embedder: Embedder,
    cfg?: Partial<ConsolidationConfig>,
  ): Promise<Consolidator> {
    const live = entries.filter((e) => !e.forgotten);
    const { vectors } = await embedder.embed(live.map((e) => e.label));
    if (vectors.length !== live.length) throw new Error("consolidator: embed count mismatch (fail-closed)");
    const byNs = new Map<Namespace, Cell[]>();
    for (let i = 0; i < live.length; i++) {
      const e = live[i]!;
      const ns = parseLabel(e.label).namespace;
      const cell: Cell = { cellId: e.cellId, namespace: ns, cur: parseCurrency(e.label), vec: normalize(vectors[i]!) };
      const g = byNs.get(ns);
      if (g) g.push(cell);
      else byNs.set(ns, [cell]);
    }
    const noopThreshold = posFiniteElse(cfg?.noopThreshold, DEFAULT_CONSOLIDATION.noopThreshold);
    const mergeThreshold = Math.min(posFiniteElse(cfg?.mergeThreshold, DEFAULT_CONSOLIDATION.mergeThreshold), noopThreshold);
    return new Consolidator(byNs, embedder, { noopThreshold, mergeThreshold });
  }

  async classify(candidateLabel: string): Promise<ConsolidationDecision> {
    const ns = parseLabel(candidateLabel).namespace;
    const cur = parseCurrency(candidateLabel);
    const { vectors } = await this.embedder.embed([candidateLabel]);
    const v0 = vectors[0];
    if (!v0) throw new Error("consolidator.classify: embedder produced no vector (fail-closed)");
    const qv = normalize(v0);
    const peers = this.byNs.get(ns) ?? [];

    const scored = peers
      .map((c) => ({ c, sim: dot(qv, c.vec) }))
      .sort((a, b) => b.sim - a.sim);
    const maxSim = scored[0]?.sim ?? 0;
    const targets = scored.filter((s) => s.sim >= this.cfg.mergeThreshold).map((s) => s.c.cellId);

    for (const { c, sim } of scored) {
      if (sim < this.cfg.mergeThreshold) break;
      if (c.cur.stem && c.cur.stem === cur.stem && dominatedBy(c.cur, cur)) {
        const rest = targets.filter((t) => t !== c.cellId);
        return {
          op: "UPDATE",
          namespace: ns,
          targets: [c.cellId, ...rest],
          maxSim,
          reason: `supersedes same-stem cell ${c.cellId.slice(0, 8)}… on version/date (sim ${maxSim.toFixed(3)})`,
        };
      }
    }
    if (maxSim >= this.cfg.noopThreshold) {
      return { op: "NOOP", namespace: ns, targets, maxSim, reason: `near-identical to an existing cell (sim ${maxSim.toFixed(3)} ≥ noop ${this.cfg.noopThreshold})` };
    }
    if (maxSim >= this.cfg.mergeThreshold) {
      return { op: "MERGE", namespace: ns, targets, maxSim, reason: `similar to ${targets.length} existing cell(s) (sim ${maxSim.toFixed(3)})` };
    }
    return { op: "ADD", namespace: ns, targets: [], maxSim, reason: `novel (max sim ${maxSim.toFixed(3)} < merge ${this.cfg.mergeThreshold})` };
  }

  redundancyClusters(): RedundancyCluster[] {
    const out: RedundancyCluster[] = [];
    for (const [ns, cells] of this.byNs) {
      const n = cells.length;
      const parent = Array.from({ length: n }, (_, i) => i);
      const find = (x: number): number => {
        let r = x;
        while (parent[r] !== r) r = parent[r]!;
        while (parent[x] !== r) { const nx = parent[x]!; parent[x] = r; x = nx; }
        return r;
      };
      const pairMin = new Map<string, number>();
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const sim = dot(cells[i]!.vec, cells[j]!.vec);
          if (sim >= this.cfg.noopThreshold) {
            pairMin.set(`${i}-${j}`, sim);
            const ri = find(i);
            const rj = find(j);
            if (ri !== rj) parent[ri] = rj;
          }
        }
      }
      const groups = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        const r = find(i);
        const g = groups.get(r);
        if (g) g.push(i);
        else groups.set(r, [i]);
      }
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        let minSim = 1;
        for (let a = 0; a < members.length; a++) {
          for (let b = a + 1; b < members.length; b++) {
            const s = pairMin.get(`${Math.min(members[a]!, members[b]!)}-${Math.max(members[a]!, members[b]!)}`);
            if (s !== undefined && s < minSim) minSim = s;
          }
        }
        out.push({
          namespace: ns,
          cellIds: members.map((i) => cells[i]!.cellId).sort(),
          minSim,
        });
      }
    }
    return out;
  }

  labelPairs(): { readonly a: string; readonly b: string; readonly namespace: Namespace; readonly cosine: number }[] {
    const out: { a: string; b: string; namespace: Namespace; cosine: number }[] = [];
    for (const [ns, cells] of this.byNs) {
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const sim = dot(cells[i]!.vec, cells[j]!.vec);
          if (sim < this.cfg.noopThreshold) continue;
          const x = cells[i]!.cellId;
          const y = cells[j]!.cellId;
          out.push(x < y ? { a: x, b: y, namespace: ns, cosine: sim } : { a: y, b: x, namespace: ns, cosine: sim });
        }
      }
    }
    return out.sort((p, q) => q.cosine - p.cosine || p.a.localeCompare(q.a));
  }

  cells(): { readonly cellId: string; readonly namespace: Namespace }[] {
    const out: { cellId: string; namespace: Namespace }[] = [];
    for (const [ns, cells] of this.byNs) for (const c of cells) out.push({ cellId: c.cellId, namespace: ns });
    return out.sort((a, b) => a.cellId.localeCompare(b.cellId));
  }

  verifyDensity(index: BodyRedundancyIndex, cfg: BodyRedundancyConfig = {}): DensityBracket {
    const minJ = cfg.minJaccard ?? DEFAULT_BODY_REDUNDANCY.minJaccard;
    const minC = cfg.minContainment ?? DEFAULT_BODY_REDUNDANCY.minContainment;

    const lp = this.labelPairs();
    let confirmed = 0;
    let refuted = 0;
    let unverifiable = 0;
    const labelKeys = new Set<string>();
    for (const p of lp) {
      labelKeys.add(`${p.a} ${p.b}`);
      const sc = index.score(p.a, p.b);
      if (sc === undefined) unverifiable++;
      else if (sc.jaccard >= minJ || sc.containment >= minC) confirmed++;
      else refuted++;
    }

    const bodyPairs = index.pairs(cfg);
    const missedByLabel = bodyPairs.filter((p) => !labelKeys.has(`${p.a} ${p.b}`));

    const cellsAll = this.cells();
    const bodyBound = densityFromPairs(cellsAll.length, bodyPairs.map((p) => [p.a, p.b] as const));

    const judged = confirmed + refuted;
    return {
      labelBound: this.density(),
      bodyBound,
      labelPairs: lp.length,
      labelConfirmed: confirmed,
      labelRefuted: refuted,
      labelUnverifiable: unverifiable,
      labelPrecision: judged === 0 ? 0 : confirmed / judged,
      missedByLabel,
      coverage: index.coverage,
    };
  }

  density(): DensityStat {
    let cells = 0;
    for (const g of this.byNs.values()) cells += g.length;
    const clusters = this.redundancyClusters();
    const redundantCells = clusters.reduce((acc, c) => acc + (c.cellIds.length - 1), 0);
    return { cells, clusters: clusters.length, redundantCells, redundancyRate: cells === 0 ? 0 : redundantCells / cells };
  }
}
