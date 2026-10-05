import { admissionOf, type AdmissionOpts, type SelectOpts } from "./scope.js";
import type { RankRetriever } from "../answer/answer_layer.js";

export type LinksLookup = (cellId: string) => readonly string[] | undefined;

export type SlugLookup = (cellId: string) => string | undefined;

export type CandidateGate = (cellIds: readonly string[], opts?: AdmissionOpts) => string[];

export interface LinkGraphStats {
  readonly cells: number;
  readonly edges: number;
  readonly resolved: number;
  readonly dangling: number;
}

export class LinkGraph {
  private constructor(
    private readonly adj: ReadonlyMap<string, readonly string[]>,
    readonly stats: LinkGraphStats,
  ) {}

  static build(cellIds: readonly string[], linksOf: LinksLookup, slugOf: SlugLookup): LinkGraph {
    const bySlug = new Map<string, string>();
    for (const cellId of cellIds) {
      const slug = slugOf(cellId);
      if (slug !== undefined && slug.length > 0 && !bySlug.has(slug)) bySlug.set(slug, cellId);
    }

    const adj = new Map<string, Set<string>>();
    let resolved = 0;
    let dangling = 0;
    for (const from of cellIds) {
      for (const target of linksOf(from) ?? []) {
        const to = bySlug.get(target);
        if (to === undefined) {
          dangling += 1;
          continue;
        }
        resolved += 1;
        if (to === from) continue;
        let a = adj.get(from);
        if (a === undefined) adj.set(from, (a = new Set()));
        a.add(to);
        let b = adj.get(to);
        if (b === undefined) adj.set(to, (b = new Set()));
        b.add(from);
      }
    }

    const frozen = new Map<string, readonly string[]>();
    let halfEdges = 0;
    for (const [cellId, set] of adj) {
      frozen.set(cellId, [...set]);
      halfEdges += set.size;
    }
    return new LinkGraph(frozen, {
      cells: cellIds.length,
      edges: halfEdges / 2,
      resolved,
      dangling,
    });
  }

  neighbours(cellId: string): readonly string[] {
    return this.adj.get(cellId) ?? [];
  }
}

export interface LinkExpansionConfig {
  readonly seedDepth: number;
  readonly maxAdded: number;
  readonly maxPerSeed: number;
}

export const DEFAULT_LINK_EXPANSION: LinkExpansionConfig = { seedDepth: 5, maxAdded: 5, maxPerSeed: 5 };

export class LinkExpansionRetriever implements RankRetriever {
  readonly name: string;
  private readonly seedDepth: number;
  private readonly maxAdded: number;
  private readonly maxPerSeed: number;

  constructor(
    private readonly base: RankRetriever & { readonly name?: string },
    private readonly graph: LinkGraph,
    private readonly gate: CandidateGate,
    cfg: Partial<LinkExpansionConfig> = {},
  ) {
    this.seedDepth = posInt(cfg.seedDepth, DEFAULT_LINK_EXPANSION.seedDepth);
    this.maxAdded = posInt(cfg.maxAdded, DEFAULT_LINK_EXPANSION.maxAdded);
    this.maxPerSeed = posInt(cfg.maxPerSeed, DEFAULT_LINK_EXPANSION.maxPerSeed);
    this.name = `link(${base.name ?? "base"})`;
  }

  async select(query: string, opts?: SelectOpts): Promise<string[]> {
    const pool = await this.base.select(query, opts);
    if (pool.length === 0) return pool;

    const inPool = new Set(pool);
    const seeds = pool.slice(0, this.seedDepth);

    const votes = new Map<string, { count: number; firstAt: number }>();
    for (let rank = 0; rank < seeds.length; rank += 1) {
      const seed = seeds[rank]!;
      let taken = 0;
      for (const neighbour of this.graph.neighbours(seed)) {
        if (taken >= this.maxPerSeed) break;
        if (inPool.has(neighbour)) continue;
        taken += 1;
        const v = votes.get(neighbour);
        if (v === undefined) votes.set(neighbour, { count: 1, firstAt: rank });
        else v.count += 1;
      }
    }
    if (votes.size === 0) return pool;

    const ranked = [...votes.entries()]
      .sort(
        (a, b) =>
          b[1].count - a[1].count ||
          a[1].firstAt - b[1].firstAt ||
          (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      )
      .map(([cellId]) => cellId);

    const gateOpts = admissionOf(opts);
    const room = Math.min(this.maxAdded, Math.floor(pool.length / 3));
    if (room === 0) return pool;
    const admitted = this.gate(ranked, gateOpts).slice(0, room);
    if (admitted.length === 0) return pool;

    const keep = pool.length - admitted.length;
    return [...pool.slice(0, keep), ...admitted];
  }
}

function posInt(v: number | undefined, fallback: number): number {
  return Number.isFinite(v) && (v as number) >= 1 ? Math.floor(v as number) : fallback;
}
