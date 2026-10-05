import { withPool, type SelectOpts } from "./scope.js";
import type { RankRetriever, ScoredHit } from "../answer/answer_layer.js";
import { DEFAULT_RERANK } from "../rerank/reranking_retriever.js";

export type ThreadStatus = "open" | "paused" | "closed";

export const KNOWN_KINDS = ["work-item", "design", "reference", "comms"] as const;

export interface LifecycleStamp {
  readonly thread?: string;
  readonly status?: ThreadStatus;
  readonly kind?: string;
  readonly conventionVersion?: number;
}

export type StampLookup = (cellId: string) => LifecycleStamp;

export interface StampSource {
  stamps(): ReadonlyMap<string, LifecycleStamp>;
}

export type DemoteMode = false | "floor" | number;

const STATUS_RE = /(?:^|[\s|,;])status\s*[:=]\s*(open|paused|closed)\b/i;
const THREAD_RE = /(?:^|[\s|,;])thread\s*[:=]\s*([a-z0-9][a-z0-9-]*)/i;
const KIND_RE = /(?:^|[\s|,;])kind\s*[:=]\s*([a-z][a-z0-9-]*)/i;
const CONV_RE = /(?:^|[\s|,;])(?:convention-version|conv-v)\s*[:=]\s*(\d{1,4})\b/i;

export function parseLifecycle(text: string): LifecycleStamp {
  const out: {
    thread?: string;
    status?: ThreadStatus;
    kind?: string;
    conventionVersion?: number;
  } = {};
  const t = THREAD_RE.exec(text);
  if (t?.[1]) out.thread = t[1].toLowerCase();
  const s = STATUS_RE.exec(text);
  if (s?.[1]) out.status = s[1].toLowerCase() as ThreadStatus;
  const k = KIND_RE.exec(text);
  if (k?.[1]) out.kind = k[1].toLowerCase();
  const c = CONV_RE.exec(text);
  if (c?.[1]) {
    const v = Number(c[1]);
    if (Number.isFinite(v)) out.conventionVersion = v;
  }
  return out;
}

function isDemotable(s: LifecycleStamp): boolean {
  return s.kind === "work-item" && s.status === "closed";
}

function isStamped(s: LifecycleStamp): boolean {
  return (
    s.thread !== undefined ||
    s.status !== undefined ||
    s.kind !== undefined ||
    s.conventionVersion !== undefined
  );
}

export function lifecycleDemote<T extends { readonly cellId: string }>(
  hits: readonly T[],
  stampOf: StampLookup,
  mode: DemoteMode = "floor",
): readonly T[] {
  if (mode === false) return hits;
  const demotable = hits.map((h) => isDemotable(stampOf(h.cellId)));
  if (!demotable.includes(true)) return hits;

  if (mode === "floor") {
    const kept: T[] = [];
    const demoted: T[] = [];
    hits.forEach((h, i) => (demotable[i] ? demoted : kept).push(h));
    return [...kept, ...demoted];
  }

  const n = Number.isFinite(mode) && mode >= 1 ? Math.floor(mode) : 1;
  return hits
    .map((h, i) => ({ h, i, d: demotable[i] === true, key: i + (demotable[i] === true ? n : 0) }))
    .sort((a, b) => a.key - b.key || Number(a.d) - Number(b.d) || a.i - b.i)
    .map((e) => e.h);
}

export function threadJoin<T extends { readonly cellId: string }>(
  hits: readonly T[],
  stampOf: StampLookup,
  maxGroup: number,
): readonly T[] {
  const byThread = new Map<string, T[]>();
  for (const h of hits) {
    const th = stampOf(h.cellId).thread;
    if (th === undefined) continue;
    const g = byThread.get(th);
    if (g) g.push(h);
    else byThread.set(th, [h]);
  }
  let anyGroup = false;
  for (const g of byThread.values()) if (g.length >= 2) { anyGroup = true; break; }
  if (!anyGroup) return hits;

  const cap = maxGroup >= 1 ? Math.floor(maxGroup) : 1;
  const emitted = new Set<string>();
  const processed = new Set<string>();
  const out: T[] = [];
  for (const h of hits) {
    if (emitted.has(h.cellId)) continue;
    const th = stampOf(h.cellId).thread;
    if (th !== undefined && !processed.has(th)) {
      processed.add(th);
      let n = 0;
      for (const m of byThread.get(th)!) {
        if (n >= cap) break;
        if (emitted.has(m.cellId)) continue;
        out.push(m);
        emitted.add(m.cellId);
        n++;
      }
    } else {
      out.push(h);
      emitted.add(h.cellId);
    }
  }
  return out;
}

export interface ThreadLifecycleConfig {
  readonly poolK: number;
  readonly maxThreadGroup: number;
  readonly join: boolean;
  readonly demote: DemoteMode;
}

export const DEFAULT_THREAD_LIFECYCLE: ThreadLifecycleConfig = {
  poolK: 30,
  maxThreadGroup: 5,
  join: true,
  demote: false,
};

export interface ThreadLifecycleStats {
  readonly attempts: number;
  readonly threadsJoined: number;
  readonly demoted: number;
  readonly stampsResolved: number;

  readonly config: ThreadLifecycleEffective;
}

export interface ThreadLifecycleEffective {
  readonly join: boolean;
  readonly demote: DemoteMode;
  readonly poolK: number;
  readonly maxThreadGroup: number;
}

function posIntOr(v: number | undefined, fallback: number): number {
  return Number.isFinite(v) && (v as number) >= 1 ? Math.floor(v as number) : fallback;
}

export class ThreadLifecycleRankRetriever implements RankRetriever {
  private readonly poolK: number;
  private readonly maxThreadGroup: number;
  private readonly join: boolean;
  private readonly demote: DemoteMode;
  private attempts = 0;
  private threadsJoined = 0;
  private demoted = 0;
  private stampsResolved = 0;

  selectScored?: (query: string, opts?: SelectOpts) => Promise<readonly ScoredHit[]>;

  constructor(
    private readonly base: RankRetriever,
    private readonly stampOf: StampLookup,
    cfg: Partial<ThreadLifecycleConfig> = {},
  ) {
    this.poolK = posIntOr(cfg.poolK, DEFAULT_THREAD_LIFECYCLE.poolK);
    this.maxThreadGroup = posIntOr(cfg.maxThreadGroup, DEFAULT_THREAD_LIFECYCLE.maxThreadGroup);
    this.join = cfg.join ?? DEFAULT_THREAD_LIFECYCLE.join;
    this.demote = cfg.demote ?? DEFAULT_THREAD_LIFECYCLE.demote;
    if (this.base.selectScored) {
      this.selectScored = (query, opts) => this.selectScoredImpl(query, opts);
    }
  }

  get stats(): ThreadLifecycleStats {
    return {
      attempts: this.attempts,
      threadsJoined: this.threadsJoined,
      demoted: this.demoted,
      stampsResolved: this.stampsResolved,
      config: {
        join: this.join,
        demote: this.demote,
        poolK: this.poolK,
        maxThreadGroup: this.maxThreadGroup,
      },
    };
  }

  private widen(maxK: number | undefined): number {
    return Math.max(this.poolK, maxK ?? this.poolK);
  }

  private reorder<T extends { readonly cellId: string }>(hits: readonly T[]): readonly T[] {
    const seen = new Map<string, number>();
    for (const h of hits) {
      const st = this.stampOf(h.cellId);
      if (isStamped(st)) this.stampsResolved++;
      if (this.demote !== false && isDemotable(st)) this.demoted++;
      if (st.thread !== undefined) seen.set(st.thread, (seen.get(st.thread) ?? 0) + 1);
    }
    if (this.join) for (const n of seen.values()) if (n >= 2) this.threadsJoined++;
    const demotedOrder = lifecycleDemote(hits, this.stampOf, this.demote);
    return this.join ? threadJoin(demotedOrder, this.stampOf, this.maxThreadGroup) : demotedOrder;
  }

  async select(query: string, opts?: SelectOpts): Promise<string[]> {
    const maxK = opts?.maxK;
    const pool = await this.base.select(query, withPool(opts, this.widen(maxK)));
    if (pool.length <= 1) return maxK !== undefined ? pool.slice(0, maxK) : pool;
    this.attempts++;
    const reordered = this.reorder(pool.map((cellId) => ({ cellId }))).map((h) => h.cellId);
    return maxK !== undefined ? reordered.slice(0, maxK) : reordered;
  }

  private async selectScoredImpl(query: string, opts?: SelectOpts): Promise<readonly ScoredHit[]> {
    const maxK = opts?.maxK;
    const pool = await this.base.selectScored!(query, withPool(opts, this.widen(maxK)));
    if (pool.length <= 1) return maxK !== undefined ? pool.slice(0, maxK) : pool;
    this.attempts++;
    const reordered = this.reorder(pool);
    return maxK !== undefined ? reordered.slice(0, maxK) : reordered;
  }
}

export function assertThreadPoolWithinRerank(opts: {
  readonly rerankK: unknown;
  readonly threadPoolK: unknown;
  readonly hasReranker: boolean;
  readonly allowWider: boolean | undefined;
}): void {
  if (!opts.hasReranker || opts.allowWider === true) return;
  const eff = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
  const effectiveRerankK = eff(opts.rerankK, DEFAULT_RERANK.rerankK);
  const wantPoolK = eff(opts.threadPoolK, DEFAULT_THREAD_LIFECYCLE.poolK);
  if (wantPoolK <= effectiveRerankK) return;
  throw new Error(
    `threadPoolK (${wantPoolK}) > rerankK (${effectiveRerankK}) widens the reranker's scored pool, ` +
      `which voids the byte-identical-when-unstamped guarantee even on a corpus with no ` +
      `stamps. Raise rerankK to >= ${wantPoolK}, lower threadPoolK, or set ` +
      `allowThreadPoolWiderThanRerank:true to accept it deliberately.`,
  );
}
