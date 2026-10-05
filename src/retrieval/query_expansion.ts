import { withPool, type SelectOpts } from "./scope.js";
import type { RankRetriever } from "../answer/answer_layer.js";

export type LabelLookup = (cellId: string) => string | undefined;

export interface QueryExpansionConfig {
  readonly prfN: number;
  readonly prfM: number;
}

export const DEFAULT_QUERY_EXPANSION: QueryExpansionConfig = { prfN: 10, prfM: 10 };

const STOP = new Set(
  ("the a an and or but of to in on at for with is are was were be been being this that these those it its as by from " +
    "what when where who whom which why how did do does done have has had will would can could should i you he she they we me my " +
    "your his her their our them us not no yes so if then than about into over under out up down off then there here").split(/\s+/),
);
const ROLE = new Set(["user", "assistant", "role", "system"]);

function tokensOf(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

export function expandQuery(query: string, seedLabels: readonly string[], m: number): string {
  const qtok = new Set(tokensOf(query));
  const df = new Map<string, number>();
  for (const label of seedLabels) {
    for (const t of new Set(tokensOf(label))) {
      if (qtok.has(t) || STOP.has(t) || ROLE.has(t)) continue;
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const terms = [...df.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.max(0, m))
    .map((e) => e[0]);
  return terms.length ? `${query} ${terms.join(" ")}` : query;
}

function posIntOr(v: number | undefined, fallback: number): number {
  return Number.isFinite(v) && (v as number) >= 1 ? Math.floor(v as number) : fallback;
}

export class PseudoRelevanceExpander implements RankRetriever {
  private readonly prfN: number;
  private readonly prfM: number;

  constructor(
    private readonly base: RankRetriever,
    private readonly labelOf: LabelLookup,
    cfg: Partial<QueryExpansionConfig> = {},
  ) {
    this.prfN = posIntOr(cfg.prfN, DEFAULT_QUERY_EXPANSION.prfN);
    this.prfM = posIntOr(cfg.prfM, DEFAULT_QUERY_EXPANSION.prfM);
  }

  async select(query: string, opts?: SelectOpts): Promise<string[]> {
    const seeds = await this.base.select(query, withPool(opts, this.prfN));
    const seedLabels: string[] = [];
    for (const id of seeds) {
      const l = this.labelOf(id);
      if (l !== undefined) seedLabels.push(l);
    }
    const expanded = expandQuery(query, seedLabels, this.prfM);
    return this.base.select(expanded, opts);
  }
}
