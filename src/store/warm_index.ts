import { retrievalText } from "../retrieval/label_text.js";
import type { Embedder } from "../embed/types.js";
import type { IndexEntry } from "../saihm_client/types.js";
import { ingestIndex } from "../ingest/index.js";
import type { IngestStats } from "../ingest/types.js";
import { SemanticRetriever, type PrecomputedRow, type RrfConfig } from "../retrieval/semantic.js";
import type { EncryptedIndexStore } from "./encrypted_store.js";
import type { PersistedRow } from "./types.js";
import { recordFlags } from "./types.js";

export interface WarmBuildOpts {
  readonly tenantId?: string;
  readonly rrf?: Partial<RrfConfig>;
  readonly name?: string;
  readonly namespaceSeparator?: string;
}

export interface WarmBuildStats {
  readonly total: number;
  readonly reused: number;
  readonly embedded: number;
  readonly stale: number;
  readonly cache: string;
  readonly saved: boolean;
  readonly saveError?: string;
}

export class WarmIndex {
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    readonly retriever: SemanticRetriever,
    readonly stats: WarmBuildStats,
    readonly ingest: IngestStats,
    private rows: PersistedRow[],
    private readonly store: EncryptedIndexStore,
    private readonly space: { modelId: string; dim: number },
  ) {}

  static _create(
    retriever: SemanticRetriever,
    stats: WarmBuildStats,
    ingest: IngestStats,
    rows: PersistedRow[],
    store: EncryptedIndexStore,
    space: { modelId: string; dim: number },
  ): WarmIndex {
    return new WarmIndex(retriever, stats, ingest, rows, store, space);
  }

  async onErased(cellId: string): Promise<void> {
    const inRam = this.retriever.forget(cellId);
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.cellId !== cellId);
    if (this.rows.length === before && !inRam) return;
    const rowsSnapshot = this.rows;
    const run = this.chain.then(() => this.store.save(rowsSnapshot, this.space));
    this.chain = run.catch(() => {});
    return run;
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  currentRows(): readonly PersistedRow[] {
    return this.rows;
  }

  get embeddingSpace(): { readonly modelId: string; readonly dim: number } {
    return this.space;
  }
}

export async function buildWarmIndex(
  entries: readonly IndexEntry[],
  embedder: Embedder,
  store: EncryptedIndexStore,
  opts?: WarmBuildOpts,
): Promise<WarmIndex> {
  const tenantId = opts?.tenantId ?? "local";
  const space = { modelId: embedder.modelId, dim: embedder.dim };
  const ing = ingestIndex(entries, { tenantId, ...(opts?.namespaceSeparator !== undefined ? { namespaceSeparator: opts.namespaceSeparator } : {}) });
  const live = ing.records.filter((r) => !r.forgotten);

  let cache = "cold";
  const pool = new Map<string, Map<string, Float32Array[]>>();
  let loadedRowCount = 0;
  try {
    const res = await store.load(space);
    if (res.state === "loaded") {
      cache = "warm";
      loadedRowCount = res.rows.length;
      for (const row of res.rows) {
        let byHash = pool.get(row.cellId);
        if (!byHash) pool.set(row.cellId, (byHash = new Map()));
        let vecs = byHash.get(row.sourceHashHex);
        if (!vecs) byHash.set(row.sourceHashHex, (vecs = []));
        vecs.push(row.vec);
      }
    } else if (res.state === "invalid") {
      cache = `invalid:${res.reason}`;
    }
  } catch (e) {
    cache = `error:${String(e)}`;
  }

  const reusedVecs = new Array<Float32Array | undefined>(live.length);
  const toEmbed: number[] = [];
  let reused = 0;
  for (let i = 0; i < live.length; i++) {
    const r = live[i]!;
    const vecs = pool.get(r.cellId)?.get(r.sourceHash);
    const vec = vecs?.pop();
    if (vec) {
      reusedVecs[i] = vec;
      reused++;
    } else {
      toEmbed.push(i);
    }
  }
  const stale = loadedRowCount - reused;

  if (toEmbed.length > 0) {
    const res = await embedder.embed(toEmbed.map((i) => retrievalText(live[i]!.label)));
    if (res.vectors.length !== toEmbed.length) {
      throw new Error(
        `embedder returned ${res.vectors.length} vectors for ${toEmbed.length} labels (fail-closed)`,
      );
    }
    for (let j = 0; j < toEmbed.length; j++) reusedVecs[toEmbed[j]!] = res.vectors[j]!;
  }

  const pre: PrecomputedRow[] = live.map((r, i) => ({
    cellId: r.cellId,
    label: r.label,
    epoch: r.ingestEpoch,
    vec: reusedVecs[i]!,
  }));
  const buildOpts: { rrf?: Partial<RrfConfig>; name?: string } = {};
  if (opts?.rrf !== undefined) buildOpts.rrf = opts.rrf;
  if (opts?.name !== undefined) buildOpts.name = opts.name;
  const retriever = SemanticRetriever.fromPrecomputed(pre, embedder, buildOpts);

  const persisted: PersistedRow[] = live.map((r, i) => ({
    cellId: r.cellId,
    sourceHashHex: r.sourceHash,
    epoch: r.ingestEpoch,
    namespace: r.namespace,
    flags: recordFlags(r),
    vec: normalizedCopy(reusedVecs[i]!),
  }));

  const changed = toEmbed.length > 0 || stale > 0 || cache !== "warm";
  let saved = false;
  let saveError: string | undefined;
  if (changed) {
    try {
      await store.save(persisted, space);
      saved = true;
    } catch (e) {
      saveError = String(e);
    }
  }

  const stats: WarmBuildStats = {
    total: live.length,
    reused,
    embedded: toEmbed.length,
    stale,
    cache,
    saved,
    ...(saveError !== undefined ? { saveError } : {}),
  };
  return WarmIndex._create(retriever, stats, ing.stats, persisted, store, space);
}

export interface WarmVerifyOpts {
  readonly tenantId?: string;
  readonly sample?: number;
  readonly maxReported?: number;
}

export interface WarmVerifyMismatch {
  readonly cellId: string;
  readonly sourceHashHex: string;
  readonly maxAbsDelta: number;
}

export interface WarmVerifyStats {
  readonly verdict: "ok" | "mismatch" | "nothing-to-check";
  readonly checked: number;
  readonly matched: number;
  readonly mismatched: number;
  readonly orphaned: number;
  readonly unembedded: number;
  readonly persistedRows: number;
  readonly sampled: boolean;
  readonly maxAbsDelta: number;
  readonly mismatches: readonly WarmVerifyMismatch[];
  readonly cache: string;
}

export async function verifyWarmIndex(
  entries: readonly IndexEntry[],
  embedder: Embedder,
  store: EncryptedIndexStore,
  opts?: WarmVerifyOpts,
): Promise<WarmVerifyStats> {
  const tenantId = opts?.tenantId ?? "local";
  const rawCap = opts?.maxReported ?? 20;
  const maxReported = Number.isFinite(rawCap) ? Math.max(0, Math.floor(rawCap)) : rawCap > 0 ? Infinity : 0;
  const space = { modelId: embedder.modelId, dim: embedder.dim };
  const live = ingestIndex(entries, { tenantId }).records.filter((r) => !r.forgotten);

  let cache = "cold";
  let rows: readonly PersistedRow[] = [];
  try {
    const res = await store.load(space);
    if (res.state === "loaded") {
      cache = "warm";
      rows = res.rows;
    } else if (res.state === "invalid") {
      cache = `invalid:${res.reason}`;
    }
  } catch (e) {
    cache = `error:${String(e)}`;
  }

  const liveByKey = new Map<string, { label: string; budget: number }>();
  for (const r of live) {
    const k = `${r.cellId}\u0000${r.sourceHash}`;
    const e = liveByKey.get(k);
    if (e) e.budget++;
    else liveByKey.set(k, { label: r.label, budget: 1 });
  }
  const verifiable: { row: PersistedRow; label: string }[] = [];
  let orphaned = 0;
  for (const row of rows) {
    const e = liveByKey.get(`${row.cellId}\u0000${row.sourceHashHex}`);
    if (e && e.budget > 0) {
      e.budget--;
      verifiable.push({ row, label: e.label });
    } else {
      orphaned++;
    }
  }
  let unembedded = 0;
  for (const e of liveByKey.values()) unembedded += e.budget;

  const want =
    opts?.sample === undefined
      ? undefined
      : Number.isFinite(opts.sample)
        ? Math.max(0, Math.min(Math.floor(opts.sample), verifiable.length))
        : opts.sample > 0
          ? verifiable.length
          : 0;
  const sampled = want !== undefined && want < verifiable.length;
  let targets = verifiable;
  if (sampled) {
    targets = [];
    for (let i = 0; i < want!; i++) targets.push(verifiable[Math.floor((i * verifiable.length) / want!)]!);
  }

  const freshByLabel = new Map<string, Float32Array>();
  const mismatches: WarmVerifyMismatch[] = [];
  let matched = 0;
  let mismatched = 0;
  let maxAbsDelta = 0;
  for (const t of targets) {
    let fresh = freshByLabel.get(t.label);
    if (!fresh) {
      const res = await embedder.embed([retrievalText(t.label)]);
      const v = res.vectors[0];
      if (res.vectors.length !== 1 || !v) {
        throw new Error(`embedder returned ${res.vectors.length} vectors for 1 label (fail-closed)`);
      }
      if (v.length !== embedder.dim) {
        throw new Error(
          `embedder declares dim ${embedder.dim} but returned ${v.length} components (fail-closed)`,
        );
      }
      fresh = normalizedCopy(v);
      freshByLabel.set(t.label, fresh);
    }
    const p = t.row.vec;
    if (p.length !== fresh.length) {
      throw new Error(
        `persisted row ${t.row.cellId} has ${p.length} components, embedder.dim is ${fresh.length} — ` +
          `the store's model-space guarantee was violated (fail-closed)`,
      );
    }
    let same = true;
    let worst = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = fresh[i]!;
      if (a !== b) {
        same = false;
        const d = Math.abs(a - b);
        const dd = Number.isNaN(d) ? Infinity : d;
        if (dd > worst) worst = dd;
      }
    }
    if (worst > maxAbsDelta) maxAbsDelta = worst;
    if (same) {
      matched++;
    } else {
      mismatched++;
      if (mismatches.length < maxReported) {
        mismatches.push({ cellId: t.row.cellId, sourceHashHex: t.row.sourceHashHex, maxAbsDelta: worst });
      }
    }
  }

  const checked = targets.length;
  return {
    verdict: checked === 0 ? "nothing-to-check" : mismatched === 0 ? "ok" : "mismatch",
    checked,
    matched,
    mismatched,
    orphaned,
    unembedded,
    persistedRows: rows.length,
    sampled,
    maxAbsDelta,
    mismatches,
    cache,
  };
}

function normalizedCopy(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  if (!Number.isFinite(n) || n === 0) {
    throw new Error(`non-normalizable embedding (norm=${n}) — fail-closed`);
  }
  const out = new Float32Array(v.length);
  const divide = Math.abs(n - 1) >= 1e-6;
  for (let i = 0; i < v.length; i++) out[i] = divide ? v[i]! / n : v[i]!;
  return out;
}
