import { SessionClosedError } from "./session_closed.js";
import { admitsSafely, type AdmissionOpts, type Scope } from "./scope.js";
import { retrievalText } from "./label_text.js";
import { isDerivedLabel } from "../derived/codec.js";
import type { IndexEntry } from "../saihm_client/types.js";
import type { MemoryRecord } from "../ingest/types.js";
import type { Embedder } from "../embed/types.js";
import { FlatStore, type VectorStore } from "./vector_store.js";
import { HnswStore, DEFAULT_HNSW, type HnswParams } from "./hnsw_store.js";
import { computeVersionSupersededBy } from "./version_supersession.js";

export interface RrfConfig {
  readonly k: number;
  readonly recencyTiebreak: boolean;
  readonly lexicalScoring: "count" | "idf";
  readonly lexicalTermSelection?: number;
}

export const DEFAULT_RRF: RrfConfig = { k: 60, recencyTiebreak: false, lexicalScoring: "count", lexicalTermSelection: 0 };

export interface SupersessionConfig {
  readonly penalty: number;
}

export const DEFAULT_SUPERSESSION: SupersessionConfig = { penalty: 0.5 };

export interface AnnConfig {
  readonly flatThreshold: number;
  readonly hnsw: HnswParams;
  readonly hnswDenseLimit: number;
}

export const DEFAULT_ANN: AnnConfig = { flatThreshold: 10_000, hnsw: DEFAULT_HNSW, hnswDenseLimit: 800 };

export interface AnnOptions {
  readonly flatThreshold?: number;
  readonly hnsw?: Partial<HnswParams>;
  readonly hnswDenseLimit?: number;
}

function resolveAnn(o?: AnnOptions): AnnConfig {
  return {
    flatThreshold: o?.flatThreshold ?? DEFAULT_ANN.flatThreshold,
    hnsw: { ...DEFAULT_HNSW, ...o?.hnsw },
    hnswDenseLimit: o?.hnswDenseLimit ?? DEFAULT_ANN.hnswDenseLimit,
  };
}

function makeStore(
  dim: number,
  items: { id: number; vec: Float32Array }[],
  ann: AnnConfig,
): { store: VectorStore; denseLimit: number; denseExhaustive: boolean } {
  if (items.length <= ann.flatThreshold) {
    return { store: new FlatStore(dim, items), denseLimit: Number.POSITIVE_INFINITY, denseExhaustive: true };
  }
  return { store: new HnswStore(dim, items, ann.hnsw), denseLimit: ann.hnswDenseLimit, denseExhaustive: false };
}

interface Row {
  readonly id: number;
  readonly cellId: string;
  readonly tokens: ReadonlySet<string>;
  readonly epoch: number;
  readonly supersededBy?: string;
  readonly derived: boolean;
  readonly retiredBy?: string;
}

export interface PrecomputedRow {
  readonly cellId: string;
  readonly label: string;
  readonly epoch: number;
  readonly vec: Float32Array;
}

interface Scored {
  readonly id: number;
  readonly score: number;
}

interface ScoredRow {
  readonly id: number;
  readonly score: number;
  readonly dense: boolean;
  readonly lexical: boolean;
}

export interface MatchProvenance {
  readonly dense: boolean;
  readonly lexical: boolean;
  readonly denseExhaustive: boolean;
}

export interface AdmittedRow {
  readonly cellId: string;
  readonly ingestEpoch: number;
  readonly supersededBy?: string;
  readonly derived?: true;
  readonly retiredBy?: string;
}

export interface RankedHit {
  readonly cellId: string;
  readonly supersededBy?: string;
  readonly derived?: true;
  readonly retiredBy?: string;
  readonly matched?: MatchProvenance;
  readonly ingestEpoch?: number;
}

export type FloorStrategy = "none" | "score-gap" | "consensus";

export interface SelectConfig {
  readonly maxK: number;
  readonly minK: number;
  readonly strategy: FloorStrategy;
  readonly asOfEpoch?: number;
  readonly excludeRetired?: boolean;
  readonly scope?: Scope;
  readonly queryVector?: QueryVector;
}

export interface QueryVector {
  readonly vector: Float32Array;
  readonly modelId: string;
}

export const DEFAULT_SELECT: SelectConfig = { maxK: 10, minK: 1, strategy: "none" };

export class SemanticRetriever {
  private fenced = false;
  readonly name: string;
  private readonly idfByToken?: Map<string, number>;
  private readonly termSelection: number;
  private readonly idfUnseen: number = 0;

  private constructor(
    private readonly byId: Map<number, Row>,
    private readonly store: VectorStore,
    private readonly denseLimit: number,
    private readonly denseExhaustive: boolean,
    private readonly embedder: Embedder,
    private readonly cfg: RrfConfig,
    private readonly sup: SupersessionConfig,
    name: string,
  ) {
    this.name = name;
    const sel = cfg.lexicalTermSelection;
    this.termSelection = Number.isFinite(sel) && (sel as number) > 0 && (sel as number) < 1 ? (sel as number) : 0;
    if (cfg.lexicalScoring === "idf" || this.termSelection > 0) {
      const df = new Map<string, number>();
      for (const row of byId.values()) for (const t of row.tokens) df.set(t, (df.get(t) ?? 0) + 1);
      const N = byId.size;
      const idf = new Map<string, number>();
      for (const [t, d] of df) idf.set(t, Math.log((N - d + 0.5) / (d + 0.5) + 1));
      this.idfByToken = idf;
      this.idfUnseen = Math.log((N + 0.5) / 0.5 + 1);
    }
  }

  static async build(
    entries: readonly IndexEntry[],
    embedder: Embedder,
    opts?: {
      rrf?: Partial<RrfConfig>;
      name?: string;
      ann?: AnnOptions;
      versionSupersession?: boolean;
      supersession?: Partial<SupersessionConfig>;
    },
  ): Promise<SemanticRetriever> {
    const live = entries.filter((e) => !e.forgotten);
    const supersededBy = opts?.versionSupersession
      ? computeVersionSupersededBy(live.map((e) => ({ cellId: e.cellId, label: e.label, epoch: e.epoch })))
      : undefined;
    const res = await embedder.embed(live.map((e) => retrievalText(e.label)));
    if (res.vectors.length !== live.length) {
      throw new Error(
        `embedder returned ${res.vectors.length} vectors for ${live.length} labels (fail-closed)`,
      );
    }
    const byId = new Map<number, Row>();
    const items: { id: number; vec: Float32Array }[] = [];
    for (let i = 0; i < live.length; i++) {
      const e = live[i]!;
      const sb = supersededBy?.get(e.cellId);
      const base = { id: i, cellId: e.cellId, tokens: tokenize(retrievalText(e.label)), epoch: e.epoch, derived: isDerivedLabel(e.label) };
      byId.set(i, sb !== undefined ? { ...base, supersededBy: sb } : base);
      items.push({ id: i, vec: l2normalize(res.vectors[i]!) });
    }
    const { store, denseLimit, denseExhaustive } = makeStore(embedder.dim, items, resolveAnn(opts?.ann));
    return new SemanticRetriever(
      byId,
      store,
      denseLimit,
      denseExhaustive,
      embedder,
      { ...DEFAULT_RRF, ...opts?.rrf },
      { ...DEFAULT_SUPERSESSION, ...opts?.supersession },
      opts?.name ?? `shm-semantic(${embedder.modelId})`,
    );
  }

  static fromPrecomputed(
    rows: readonly PrecomputedRow[],
    embedder: Embedder,
    opts?: {
      rrf?: Partial<RrfConfig>;
      name?: string;
      ann?: AnnOptions;
      versionSupersession?: boolean;
      supersession?: Partial<SupersessionConfig>;
    },
  ): SemanticRetriever {
    const supersededBy = opts?.versionSupersession
      ? computeVersionSupersededBy(rows.map((r) => ({ cellId: r.cellId, label: r.label, epoch: r.epoch })))
      : undefined;
    const byId = new Map<number, Row>();
    const items: { id: number; vec: Float32Array }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.vec.length !== embedder.dim) {
        throw new Error(
          `precomputed vector for ${r.cellId} has dim ${r.vec.length}, embedder ${embedder.modelId} wants ${embedder.dim} (fail-closed)`,
        );
      }
      const sb = supersededBy?.get(r.cellId);
      const base = { id: i, cellId: r.cellId, tokens: tokenize(retrievalText(r.label)), epoch: r.epoch, derived: isDerivedLabel(r.label) };
      byId.set(i, sb !== undefined ? { ...base, supersededBy: sb } : base);
      items.push({ id: i, vec: l2normalize(r.vec) });
    }
    const { store, denseLimit, denseExhaustive } = makeStore(embedder.dim, items, resolveAnn(opts?.ann));
    return new SemanticRetriever(
      byId,
      store,
      denseLimit,
      denseExhaustive,
      embedder,
      { ...DEFAULT_RRF, ...opts?.rrf },
      { ...DEFAULT_SUPERSESSION, ...opts?.supersession },
      opts?.name ?? `shm-semantic(${embedder.modelId})`,
    );
  }

  static async fromRecords(
    records: readonly MemoryRecord[],
    embedder: Embedder,
    opts?: {
      rrf?: Partial<RrfConfig>;
      name?: string;
      ann?: AnnOptions;
      supersession?: Partial<SupersessionConfig>;
      versionSupersession?: boolean;
    },
  ): Promise<SemanticRetriever> {
    const live = records.filter((r) => !r.forgotten);
    const supersededBy = opts?.versionSupersession
      ? computeVersionSupersededBy(live.map((r) => ({ cellId: r.cellId, label: r.label, epoch: r.ingestEpoch })))
      : new Map<string, string>();
    for (const [k, v] of computeSupersededBy(live)) supersededBy.set(k, v);
    const res = await embedder.embed(live.map((r) => retrievalText(r.label)));
    if (res.vectors.length !== live.length) {
      throw new Error(
        `embedder returned ${res.vectors.length} vectors for ${live.length} labels (fail-closed)`,
      );
    }
    const byId = new Map<number, Row>();
    const items: { id: number; vec: Float32Array }[] = [];
    for (let i = 0; i < live.length; i++) {
      const r = live[i]!;
      const sb = supersededBy.get(r.cellId);
      const base = { id: i, cellId: r.cellId, tokens: tokenize(retrievalText(r.label)), epoch: r.ingestEpoch, derived: isDerivedLabel(r.label) };
      byId.set(i, sb !== undefined ? { ...base, supersededBy: sb } : base);
      items.push({ id: i, vec: l2normalize(res.vectors[i]!) });
    }
    const { store, denseLimit, denseExhaustive } = makeStore(embedder.dim, items, resolveAnn(opts?.ann));
    return new SemanticRetriever(
      byId,
      store,
      denseLimit,
      denseExhaustive,
      embedder,
      { ...DEFAULT_RRF, ...opts?.rrf },
      { ...DEFAULT_SUPERSESSION, ...opts?.supersession },
      opts?.name ?? `shm-semantic(${embedder.modelId})`,
    );
  }

  fence(): void {
    this.fenced = true;
  }

  private assertOpen(what: string): void {
    if (this.fenced) throw new SessionClosedError(`SemanticRetriever.${what}`);
  }

  forget(cellId: string): boolean {
    this.withheld.delete(cellId);
    let found = false;
    for (const [id, row] of this.byId) {
      if (row.cellId === cellId) {
        this.store.remove(id);
        this.byId.delete(id);
        found = true;
      }
    }
    return found;
  }

  setRetirements(map: ReadonlyMap<string, string>): void {
    const liveIds = new Set<string>();
    for (const row of this.byId.values()) liveIds.add(row.cellId);
    for (const [id, row] of this.byId) {
      const by = map.get(row.cellId);
      const next = by !== undefined && liveIds.has(by) ? by : undefined;
      if (next === row.retiredBy) continue;
      const { retiredBy: _old, ...rest } = row;
      this.byId.set(id, next !== undefined ? { ...rest, retiredBy: next } : rest);
    }
  }

  private withheld = new Set<string>();
  setWithheld(cellIds: Iterable<string>): void {
    this.withheld = new Set(cellIds);
  }
  isWithheld(cellId: string): boolean {
    return this.withheld.has(cellId);
  }
  holds(cellId: string): boolean {
    for (const row of this.byId.values()) if (row.cellId === cellId) return true;
    return false;
  }

  private retiredOut(row: Row, scope: Scope | undefined, excludeRetired: boolean | undefined): boolean {
    return excludeRetired === true && row.retiredBy !== undefined && admitsSafely(scope, row.retiredBy);
  }

  vetCandidates(cellIds: readonly string[], opts?: AdmissionOpts): string[] {
    this.assertOpen("vetCandidates");
    if (cellIds.length === 0) return [];
    const asOfEpoch = opts?.asOfEpoch;
    const scope = opts?.scope;
    const wanted = new Set(cellIds);
    const admitted = new Set<string>();
    for (const row of this.byId.values()) {
      if (!wanted.has(row.cellId)) continue;
      if (asOfEpoch !== undefined && !(row.epoch <= asOfEpoch)) continue;
      if (!admitsSafely(scope, row.cellId)) continue;
      if (this.retiredOut(row, scope, opts?.excludeRetired)) continue;
      if (this.withheld.has(row.cellId)) continue;
      admitted.add(row.cellId);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const cellId of cellIds) {
      if (admitted.has(cellId) && !seen.has(cellId)) {
        seen.add(cellId);
        out.push(cellId);
      }
    }
    return out;
  }

  async retrieve(query: string, k: number): Promise<string[]> {
    this.assertOpen("retrieve");
    const order = await this.rank(query, k);
    return order.map((id) => this.byId.get(id)!.cellId);
  }

  async retrieveDetailed(query: string, k: number): Promise<RankedHit[]> {
    this.assertOpen("retrieveDetailed");
    const rows = await this.rankRows(query, k);
    return rows.map((x) => this.hitOf(x));
  }

  private hitOf(x: ScoredRow, scope?: Scope): RankedHit {
    const row = this.byId.get(x.id)!;
    const matched: MatchProvenance = {
      dense: x.dense,
      lexical: x.lexical,
      denseExhaustive: this.denseExhaustive,
    };
    const sb = row.supersededBy;
    const derived = row.derived ? { derived: true as const } : {};
    const rb = row.retiredBy;
    const retired = rb !== undefined && admitsSafely(scope, rb) ? { retiredBy: rb } : {};
    return sb !== undefined && admitsSafely(scope, sb)
      ? { cellId: row.cellId, supersededBy: sb, matched, ingestEpoch: row.epoch, ...derived, ...retired }
      : { cellId: row.cellId, matched, ingestEpoch: row.epoch, ...derived, ...retired };
  }

  async select(query: string, opts?: Partial<SelectConfig>): Promise<string[]> {
    this.assertOpen("select");
    return (await this.selectDetailed(query, opts)).map((h) => h.cellId);
  }

  async selectDetailed(query: string, opts?: Partial<SelectConfig>): Promise<RankedHit[]> {
    this.assertOpen("selectDetailed");
    const cfg: SelectConfig = { ...DEFAULT_SELECT, ...opts };
    const arr = await this.rankScored(query, cfg.asOfEpoch, cfg.scope, cfg.excludeRetired, cfg.queryVector);
    const seen = new Set<string>();
    const distinct: ScoredRow[] = [];
    for (const x of arr) {
      const cid = this.byId.get(x.id)!.cellId;
      if (seen.has(cid)) continue;
      seen.add(cid);
      distinct.push(x);
    }
    if (distinct.length === 0) return [];
    const keep = floorCut(distinct, cfg);
    return distinct.slice(0, keep).map((x) => this.hitOf(x, cfg.scope));
  }

  private selectQueryTokens(qtok: Set<string>): Set<string> {
    if (this.termSelection === 0 || this.idfByToken === undefined || qtok.size === 0) return qtok;
    const drop = Math.floor(qtok.size * this.termSelection);
    if (drop === 0) return qtok;
    const ranked = [...qtok].sort((a, b) => {
      const ia = this.idfByToken!.get(a) ?? this.idfUnseen;
      const ib = this.idfByToken!.get(b) ?? this.idfUnseen;
      return ia - ib || (a < b ? -1 : a > b ? 1 : 0);
    });
    return new Set(ranked.slice(drop));
  }

  census(scope: Scope): { readonly admitted: number; readonly excluded: number; readonly total: number } {
    this.assertOpen("census");
    const seen = new Set<string>();
    let admitted = 0;
    let excluded = 0;
    for (const row of this.byId.values()) {
      if (seen.has(row.cellId)) continue;
      seen.add(row.cellId);
      if (admitsSafely(scope, row.cellId) && !this.withheld.has(row.cellId)) admitted++;
      else excluded++;
    }
    return { admitted, excluded, total: admitted + excluded };
  }

  enumerate(scope: Scope, opts?: { asOfEpoch?: number }): readonly AdmittedRow[] {
    this.assertOpen("enumerate");
    const asOfEpoch = opts?.asOfEpoch;
    const best = new Map<string, { epoch: number; supersededBy?: string; retiredBy?: string; derived: boolean }>();
    for (const row of this.byId.values()) {
      if (asOfEpoch !== undefined && !(row.epoch <= asOfEpoch)) continue;
      if (!admitsSafely(scope, row.cellId)) continue;
      if (this.withheld.has(row.cellId)) continue;
      const cur = best.get(row.cellId);
      if (cur === undefined || row.epoch < cur.epoch) {
        best.set(row.cellId, {
          epoch: row.epoch, derived: row.derived,
          ...(row.supersededBy !== undefined ? { supersededBy: row.supersededBy } : {}),
          ...(row.retiredBy !== undefined ? { retiredBy: row.retiredBy } : {}),
        });
      }
    }
    const out: AdmittedRow[] = [];
    for (const [cellId, r] of best) {
      const sb = r.supersededBy;
      const derived = r.derived ? { derived: true as const } : {};
      const retired = r.retiredBy !== undefined && admitsSafely(scope, r.retiredBy) ? { retiredBy: r.retiredBy } : {};
      out.push(
        sb !== undefined && admitsSafely(scope, sb)
          ? { cellId, ingestEpoch: r.epoch, supersededBy: sb, ...derived, ...retired }
          : { cellId, ingestEpoch: r.epoch, ...derived, ...retired },
      );
    }
    out.sort((a, b) => a.ingestEpoch - b.ingestEpoch || (a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0));
    return out;
  }

  async embedQuery(query: string): Promise<QueryVector> {
    const qres = await this.embedder.embed([query]);
    const q0 = qres.vectors[0];
    if (!q0) throw new Error("query embedding produced no vector (fail-closed)");
    return { vector: q0, modelId: this.embedder.modelId };
  }

  private async rankScored(query: string, asOfEpoch?: number, scope?: Scope, excludeRetired?: boolean, queryVector?: QueryVector): Promise<ScoredRow[]> {
    let q0: Float32Array;
    if (queryVector !== undefined) {
      if (queryVector.modelId !== this.embedder.modelId) {
        throw new Error(`queryVector came from model ${JSON.stringify(queryVector.modelId)}; this retriever embeds with ${JSON.stringify(this.embedder.modelId)} (fail-closed: a foreign vector would rank silently)`);
      }
      if (queryVector.vector.length !== this.embedder.dim) {
        throw new Error(`queryVector has dimension ${queryVector.vector.length}; this retriever's embedder produces ${this.embedder.dim} (fail-closed: a foreign vector would rank silently)`);
      }
      q0 = queryVector.vector;
    } else {
      q0 = (await this.embedQuery(query)).vector;
    }
    const qv = l2normalize(q0);
    const qtok = this.selectQueryTokens(tokenize(query));

    const within =
      asOfEpoch === undefined && scope === undefined && excludeRetired !== true && this.withheld.size === 0
        ? undefined
        : (id: number): boolean => {
            const row = this.byId.get(id)!;
            return (
              (asOfEpoch === undefined || row.epoch <= asOfEpoch) &&
              admitsSafely(scope, row.cellId) &&
              !this.retiredOut(row, scope, excludeRetired) &&
              !this.withheld.has(row.cellId)
            );
          };

    const rrf = new Map<number, number>();
    const inDense = new Set<number>();
    const inLexical = new Set<number>();

    const dense = this.store.query(qv, this.denseLimit);
    const denseC = within ? dense.filter((h) => within(h.id)) : dense;
    for (const h of denseC) inDense.add(h.id);
    this.rankInto(rrf, denseC);

    if (qtok.size > 0) {
      const useIdf = this.cfg.lexicalScoring === "idf" && this.idfByToken !== undefined;
      const lex: Scored[] = [];
      for (const row of this.byId.values()) {
        if (within && !within(row.id)) continue;
        const score = useIdf ? idfOverlap(qtok, row.tokens, this.idfByToken!) : overlap(qtok, row.tokens);
        if (score > 0) lex.push({ id: row.id, score });
      }
      for (const h of lex) inLexical.add(h.id);
      this.rankInto(rrf, lex);
    }

    if (this.sup.penalty > 0) {
      for (const [id, score] of rrf) {
        const sb = this.byId.get(id)!.supersededBy;
        if (sb !== undefined && admitsSafely(scope, sb)) {
          rrf.set(id, score * (1 - this.sup.penalty));
        }
      }
    }

    const arr: ScoredRow[] = [];
    for (const [id, score] of rrf)
      arr.push({ id, score, dense: inDense.has(id), lexical: inLexical.has(id) });
    arr.sort((a, b) => b.score - a.score || this.tiebreak(a.id, b.id));
    return arr;
  }

  private async rank(query: string, k: number): Promise<number[]> {
    return (await this.rankRows(query, k)).map((x) => x.id);
  }

  private async rankRows(query: string, k: number): Promise<ScoredRow[]> {
    const arr = await this.rankScored(query);
    return arr.slice(0, Math.max(k, 200));
  }

  private rankInto(acc: Map<number, number>, hits: Scored[]): void {
    hits.sort((a, b) => b.score - a.score || this.tiebreak(a.id, b.id));
    for (let r = 0; r < hits.length; r++) {
      const id = hits[r]!.id;
      acc.set(id, (acc.get(id) ?? 0) + 1 / (this.cfg.k + r + 1));
    }
  }

  private tiebreak(a: number, b: number): number {
    const ra = this.byId.get(a)!;
    const rb = this.byId.get(b)!;
    if (this.cfg.recencyTiebreak) {
      const de = rb.epoch - ra.epoch;
      if (Number.isFinite(de) && de !== 0) return de;
    }
    return ra.cellId < rb.cellId ? -1 : ra.cellId > rb.cellId ? 1 : 0;
  }
}

function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  if (!Number.isFinite(n) || n === 0) {
    throw new Error(`non-normalizable embedding (norm=${n}) — fail-closed`);
  }
  if (Math.abs(n - 1) < 1e-6) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

function overlap(q: ReadonlySet<string>, r: ReadonlySet<string>): number {
  let hits = 0;
  for (const t of q) if (r.has(t)) hits++;
  return hits;
}

function idfOverlap(q: ReadonlySet<string>, r: ReadonlySet<string>, idf: ReadonlyMap<string, number>): number {
  let s = 0;
  for (const t of q) if (r.has(t)) s += idf.get(t) ?? 0;
  return s;
}

function computeSupersededBy(live: readonly MemoryRecord[]): Map<string, string> {
  const liveIds = new Set(live.map((r) => r.cellId));
  const best = new Map<string, { cellId: string; epoch: number }>();
  for (const x of live) {
    for (const edge of x.supersedes) {
      if (edge.kind !== "cellId" && edge.kind !== "cellIdPrefix" && edge.kind !== "cellIdStem") continue;
      const target = edge.target;
      if (target === x.cellId || !liveIds.has(target)) continue;
      const prev = best.get(target);
      if (
        prev === undefined ||
        x.ingestEpoch > prev.epoch ||
        (x.ingestEpoch === prev.epoch && x.cellId < prev.cellId)
      ) {
        best.set(target, { cellId: x.cellId, epoch: x.ingestEpoch });
      }
    }
  }
  const m = new Map<string, string>();
  for (const [target, v] of best) m.set(target, v.cellId);
  return m;
}

function floorCut(arr: readonly ScoredRow[], cfg: SelectConfig): number {
  const n = arr.length;
  const hi = Math.min(Math.max(cfg.maxK, 1), n);
  const lo = Math.min(Math.max(cfg.minK, 1), hi);
  if (cfg.strategy === "none" || hi <= lo) return hi;

  if (cfg.strategy === "consensus") {
    let last = -1;
    for (let i = 0; i < hi; i++) if (arr[i]!.dense && arr[i]!.lexical) last = i;
    return Math.min(Math.max(last + 1, lo), hi);
  }

  const GAP_MIN = 0.2;
  let bestCut = hi;
  let bestGap = GAP_MIN;
  for (let i = lo; i < hi; i++) {
    const prev = arr[i - 1]!.score;
    const cur = arr[i]!.score;
    const gap = prev <= 0 ? 0 : (prev - cur) / prev;
    if (gap > bestGap) {
      bestGap = gap;
      bestCut = i;
    }
  }
  return Math.min(Math.max(bestCut, lo), hi);
}

export function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
}
