import type { Namespace } from "../ingest/types.js";
import type { BodySource } from "../answer/types.js";

export const DEFAULT_SHINGLE_K = 5;

export interface BodyRedundancyConfig {
  readonly shingleK?: number;
  readonly minJaccard?: number;
  readonly minContainment?: number;
}

export const DEFAULT_BODY_REDUNDANCY = {
  shingleK: DEFAULT_SHINGLE_K,
  minJaccard: 0.5,
  minContainment: 0.8,
} as const;

export function shingleSet(text: string, k: number = DEFAULT_SHINGLE_K): Set<string> {
  const width = Number.isFinite(k) && k >= 1 ? Math.floor(k) : DEFAULT_SHINGLE_K;
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length <= width) {
    out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i + width <= tokens.length; i++) {
    out.add(tokens.slice(i, i + width).join(" "));
  }
  return out;
}

function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const s of small) if (large.has(s)) n++;
  return n;
}

export function jaccardOf(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const inter = intersectionSize(a, b);
  return inter / (a.size + b.size - inter);
}

export function containmentOf(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0) return 0;
  return intersectionSize(a, b) / a.size;
}

export interface BodyPair {
  readonly a: string;
  readonly b: string;
  readonly namespace: Namespace;
  readonly jaccard: number;
  readonly containment: number;
  readonly subsumed?: string;
}

export interface BodyRedundancyStats {
  readonly withBody: number;
  readonly withoutBody: number;
  readonly totalShingles: number;
  readonly comparedPairs: number;
}

export class BodyRedundancyIndex {
  private readonly shingles = new Map<string, Set<string>>();
  private readonly nsOf = new Map<string, Namespace>();
  private stats: BodyRedundancyStats = { withBody: 0, withoutBody: 0, totalShingles: 0, comparedPairs: 0 };

  private constructor(private readonly k: number) {}

  static fromTexts(
    cells: readonly { readonly cellId: string; readonly namespace: Namespace; readonly text: string }[],
    cfg: BodyRedundancyConfig = {},
  ): BodyRedundancyIndex {
    const idx = new BodyRedundancyIndex(cfg.shingleK ?? DEFAULT_BODY_REDUNDANCY.shingleK);
    let withBody = 0;
    let withoutBody = 0;
    let total = 0;
    for (const c of cells) {
      const set = shingleSet(c.text, idx.k);
      if (set.size === 0) {
        withoutBody++;
        continue;
      }
      idx.shingles.set(c.cellId, set);
      idx.nsOf.set(c.cellId, c.namespace);
      withBody++;
      total += set.size;
    }
    idx.stats = { withBody, withoutBody, totalShingles: total, comparedPairs: 0 };
    return idx;
  }

  static async fromBodySource(
    cells: readonly { readonly cellId: string; readonly namespace: Namespace }[],
    bodies: BodySource,
    cfg: BodyRedundancyConfig = {},
  ): Promise<BodyRedundancyIndex> {
    const ids = cells.map((c) => c.cellId);
    const byId = new Map<string, string>();
    if (ids.length > 0) {
      const fetched = await bodies.fetchByIds(ids);
      for (const b of fetched) {
        if (b.partial === true) continue;
        byId.set(b.cellId, b.plaintext);
      }
    }
    return BodyRedundancyIndex.fromTexts(
      cells.map((c) => ({ cellId: c.cellId, namespace: c.namespace, text: byId.get(c.cellId) ?? "" })),
      cfg,
    );
  }

  get coverage(): BodyRedundancyStats {
    return this.stats;
  }

  shinglesOf(cellId: string): ReadonlySet<string> | undefined {
    return this.shingles.get(cellId);
  }

  pairs(cfg: BodyRedundancyConfig = {}): BodyPair[] {
    const minJ = cfg.minJaccard ?? DEFAULT_BODY_REDUNDANCY.minJaccard;
    const minC = cfg.minContainment ?? DEFAULT_BODY_REDUNDANCY.minContainment;

    const posting = new Map<string, string[]>();
    for (const [cellId, set] of this.shingles) {
      for (const s of set) {
        const list = posting.get(s);
        if (list) list.push(cellId);
        else posting.set(s, [cellId]);
      }
    }

    const candidates = new Set<string>();
    for (const list of posting.values()) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const x = list[i]!;
          const y = list[j]!;
          if (this.nsOf.get(x) !== this.nsOf.get(y)) continue;
          candidates.add(x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
        }
      }
    }

    const out: BodyPair[] = [];
    for (const key of candidates) {
      const sep = key.indexOf("\u0000");
      const a = key.slice(0, sep);
      const b = key.slice(sep + 1);
      const sa = this.shingles.get(a)!;
      const sb = this.shingles.get(b)!;
      const j = jaccardOf(sa, sb);
      const ca = containmentOf(sa, sb);
      const cb = containmentOf(sb, sa);
      const containment = Math.max(ca, cb);
      if (j < minJ && containment < minC) continue;
      const pair: BodyPair = {
        a, b,
        namespace: this.nsOf.get(a)!,
        jaccard: j,
        containment,
        ...(ca > cb ? { subsumed: a } : cb > ca ? { subsumed: b } : {}),
      };
      out.push(pair);
    }
    this.stats = { ...this.stats, comparedPairs: candidates.size };
    return out.sort((p, q) => q.jaccard - p.jaccard || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
  }

  score(a: string, b: string): { readonly jaccard: number; readonly containment: number } | undefined {
    const sa = this.shingles.get(a);
    const sb = this.shingles.get(b);
    if (!sa || !sb) return undefined;
    return {
      jaccard: jaccardOf(sa, sb),
      containment: Math.max(containmentOf(sa, sb), containmentOf(sb, sa)),
    };
  }
}
