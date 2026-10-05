import type { RankedSource } from "../rerank/reranking_retriever.js";

export type DocumentLookup = (cellId: string) => string | undefined;

export interface AggregationConfig {
  readonly poolK: number;
  readonly anchorJ: number;
  readonly alpha: number;
  readonly rrfK: number;
}

export const DEFAULT_AGGREGATION: AggregationConfig = { poolK: 30, anchorJ: 8, alpha: 0.25, rrfK: 60 };

export interface CalibrationSample {
  readonly pool: readonly string[];
  readonly isRelevant: readonly boolean[];
  readonly documentOf: DocumentLookup;
}

export interface CalibrationResult {
  readonly anchorJ: number | undefined;
  readonly sweep: readonly { readonly anchorJ: number; readonly dHit: number; readonly dPrecision: number }[];
  readonly samples: number;
  readonly vacuous: boolean;
}

export function calibrateAnchor(
  samples: readonly CalibrationSample[],
  opts: { readonly k?: number; readonly maxHitDrop?: number; readonly cfg?: Partial<AggregationConfig> } = {},
): CalibrationResult {
  const k = Number.isFinite(opts.k) && (opts.k as number) >= 1 ? Math.floor(opts.k as number) : 10;
  const maxHitDrop = Number.isFinite(opts.maxHitDrop) ? (opts.maxHitDrop as number) : -0.02;
  const cfg = normalizeAggregation(opts.cfg ?? {});
  const usable = samples.filter((s) => s.pool.length > 1 && s.pool.length === s.isRelevant.length);
  const sweep: { anchorJ: number; dHit: number; dPrecision: number }[] = [];
  if (usable.length === 0) return { anchorJ: undefined, sweep, samples: 0, vacuous: true };
  const vacuous = usable.every((s) => {
    const seen = new Set<string>();
    return !s.pool.some((id) => { const d = s.documentOf(id); if (d === undefined) return false; if (seen.has(d)) return true; seen.add(d); return false; });
  });

  const rel = new Map<CalibrationSample, (id: string) => boolean>();
  for (const s of usable) {
    const m = new Map<string, boolean>();
    s.pool.forEach((id, i) => { if (s.isRelevant[i]) m.set(id, true); });
    rel.set(s, (id) => m.get(id) === true);
  }
  const measure = (order: (s: CalibrationSample) => readonly string[]): { hit: number; prec: number } => {
    let hit = 0, prec = 0;
    for (const s of usable) {
      const top = order(s).slice(0, k);
      const n = top.filter(rel.get(s)!).length;
      hit += n > 0 ? 1 : 0;
      prec += top.length ? n / top.length : 0;
    }
    return { hit: hit / usable.length, prec: prec / usable.length };
  };

  const base = measure((s) => s.pool);
  let chosen: number | undefined;
  for (let j = 1; j < cfg.poolK; j++) {
    const m = measure((s) => aggregateOrder(s.pool, s.documentOf, { ...cfg, anchorJ: j }));
    sweep.push({ anchorJ: j, dHit: m.hit - base.hit, dPrecision: m.prec - base.prec });
    if (chosen === undefined && m.hit - base.hit >= maxHitDrop) chosen = j;
  }
  return { anchorJ: vacuous ? undefined : chosen, sweep, samples: usable.length, vacuous };
}

export function normalizeAggregation(cfg: Partial<AggregationConfig>): AggregationConfig {
  const num = (v: unknown, min: number, fallback: number, floor = true): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) return fallback;
    return floor ? Math.floor(v) : v;
  };
  return {
    poolK: num(cfg.poolK, 1, DEFAULT_AGGREGATION.poolK),
    anchorJ: num(cfg.anchorJ, 0, DEFAULT_AGGREGATION.anchorJ),
    alpha: num(cfg.alpha, 0, DEFAULT_AGGREGATION.alpha, false),
    rrfK: num(cfg.rrfK, 1, DEFAULT_AGGREGATION.rrfK),
  };
}

export function aggregateOrder(
  pool: readonly string[],
  documentOf: DocumentLookup,
  cfg: AggregationConfig,
): string[] {
  const n = pool.length;
  if (n <= 1) return [...pool];
  const c = normalizeAggregation(cfg);
  const j = Math.min(c.anchorJ, n);
  if (j >= n) return [...pool];

  const w = (i: number): number => 1 / (c.rrfK + i);
  const key: (string | number)[] = pool.map((id, i) => documentOf(id) ?? i);
  const support = new Map<string | number, number>();
  for (let i = 0; i < n; i++) support.set(key[i]!, (support.get(key[i]!) ?? 0) + w(i));

  const score = (i: number): number => w(i) + c.alpha * support.get(key[i]!)!;
  const movable: number[] = [];
  for (let i = j; i < n; i++) movable.push(i);
  movable.sort((a, b) => score(b) - score(a) || a - b);
  return [...pool.slice(0, j), ...movable.map((i) => pool[i]!)];
}

export class DocumentAggregatingRetriever implements RankedSource {
  readonly name: string;
  private readonly cfg: AggregationConfig;

  constructor(
    private readonly base: RankedSource,
    private readonly documentOf: DocumentLookup,
    cfg: Partial<AggregationConfig> = {},
  ) {
    const { poolK, anchorJ, alpha, rrfK } = normalizeAggregation(cfg);

    if (anchorJ >= poolK) {
      throw new RangeError(
        `document_aggregation: anchorJ (${anchorJ}) >= poolK (${poolK}) anchors the whole pool, ` +
          `which disables aggregation silently. Lower anchorJ or raise poolK.`,
      );
    }

    this.cfg = { poolK, anchorJ, alpha, rrfK };
    this.name = `docagg(J=${anchorJ},a=${alpha})/${base.name}`;
  }

  async retrieve(query: string, k: number): Promise<string[]> {
    const depth = Math.max(k, this.cfg.poolK);
    const base = await this.base.retrieve(query, depth);
    if (base.length <= 1) return base;
    const poolN = Math.min(this.cfg.poolK, base.length);
    return [...aggregateOrder(base.slice(0, poolN), this.documentOf, this.cfg), ...base.slice(poolN)];
  }
}
