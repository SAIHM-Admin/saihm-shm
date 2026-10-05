import type { Embedder } from "../embed/types.js";
import type { SaihmReadPort } from "../saihm_client/types.js";
import { checkEntitlement, type SubscriptionSource } from "../entitlement/entitlement.js";
import type { RrfConfig, SemanticRetriever } from "../retrieval/semantic.js";
import { EncryptedIndexStore } from "../store/encrypted_store.js";
import { buildWarmIndex, type WarmIndex } from "../store/warm_index.js";
import { SaihmBodySource, type SaihmBodySourceConfig } from "../answer/saihm_body_source.js";
import { CachingBodySource, DEFAULT_CACHE_CONFIG, type CacheStats } from "../answer/caching_body_source.js";
import { PersistentBodySource, type PersistentBodyStats } from "../answer/persistent_body_source.js";
import { OwnCellBodySource, type OwnCellBodyStats, type OwnCellReader } from "../answer/own_cell_body_source.js";
import { restoreOrCold, takeSnapshot, type TakeOutcome, type WarmStart } from "../store/warm_start.js";
import { decodeIndexPart, encodeIndexPart, IndexPartError, INDEX_PART_NAME } from "../store/index_snapshot.js";
import { CorpusWarmer, type WarmOptions, type WarmResult } from "../answer/corpus_warmer.js";
import type { BodySource, ServeStep } from "../answer/types.js";
import type { RankRetriever } from "../answer/answer_layer.js";
import type { RerankingRankRetriever } from "../rerank/reranking_select.js";
import { composeLeverStack, type LeverStackDeps } from "../tuning/lever_stack.js";
import {
  ThreadLifecycleRankRetriever,
  parseLifecycle,
  DEFAULT_THREAD_LIFECYCLE,
} from "../retrieval/thread_lifecycle.js";
import type {
  ThreadLifecycleEffective,
  ThreadLifecycleStats,
  LifecycleStamp,
  StampLookup,
  DemoteMode,
} from "../retrieval/thread_lifecycle.js";
import type { Reranker } from "../rerank/types.js";
import { ProactiveInjector } from "../inject/proactive_injector.js";
import type { InjectionBudget, CueDeriver, TokenEstimate } from "../inject/proactive_injector.js";
import type { AtRestPresence, EncryptedBodyStore } from "../store/body_store.js";
import { ErasureBus, ErasureDetector } from "../erasure/bus.js";
import { IndexWatcher } from "../erasure/index_watcher.js";
import { FeedWatcher, FileFeedCursorStore, resolveFeedPath, type FeedFault, type FeedSink, type FeedWatcherStatus } from "../erasure/feed_watcher.js";
import { FileWithheldStore, MemoryWithheldStore, type WithheldStore } from "../erasure/withheld_store.js";
import { acquireWriterLock, canonicalLockDir, type WriterLock } from "../store/writer_lock.js";
import { collectListing, decideFromIndex, decideFromListing, decideFromProbe, summarize, type ListingCandidate, type ProbeResult, type ReconcileCandidate, type ReconcileDecision, type ReconcileSummary } from "../erasure/reconcile.js";
import { resolveChangesPath } from "../erasure/changes_feed.js";
import { ChangeFeedFollower, type ChangeFeedFollowerStatus } from "./change_feed.js";
import { parseServerFeatures } from "../saihm_client/server_features.js";
import type { Entitlement } from "../entitlement/entitlement.js";
import { FederatedReadPort } from "../saihm_client/federated_port.js";
import { homedir } from "node:os";
import { dirname, join as joinPath } from "node:path";
import { ContentFingerprintIndex } from "../standing/content_fingerprint.js";
import { surfaceStanding } from "../standing/surface.js";
import type { StandingRecorder, StandingSurface } from "../standing/surface.js";
import type { StandingRecallConfig } from "../standing/standing_answers.js";
import type { FingerprintScope } from "../standing/content_fingerprint.js";
import type { LabelLookup } from "../rerank/reranking_retriever.js";
import { parseLabel } from "../ingest/parse.js";
import type { IngestStats, Namespace } from "../ingest/types.js";
import { scopeFrom, withLineage, composeScopes, type Scope, type ScopeSpec } from "../retrieval/scope.js";
import { isDerivedLabel } from "../derived/codec.js";
import { assembleThread, type ThreadAccount } from "../assemble/thread.js";
import { assembleHistory, epochsFromHits, type HistoryReport } from "../history/answerable.js";
import { assembleFleetReport, type FleetReport, type FleetRow, type FleetPolicy } from "../fleet/knowledge.js";
import { assembleComplianceReport, type ComplianceOptions, type ComplianceReport } from "../compliance/report.js";
import { planTiers, type Tier, type TierPolicy, type TierPlan, type TierSignals } from "../tiers/membership.js";
import type { AuditTrail } from "../compliance/trail.js";
import type { InjectionResult } from "../inject/proactive_injector.js";
import { Consolidator, type RedundancyCluster } from "../consolidate/consolidator.js";
import type { IndexEntry } from "../saihm_client/types.js";
import type { RankedHit } from "../retrieval/semantic.js";
import type { FreshnessLookup } from "../assemble/brief.js";
import { verifyResume, type ResumeClaim, type ResumeReport, type Probe } from "../resume/resume.js";

export interface OpenMemorySessionOptions {
  readonly port: SaihmReadPort;
  readonly entitlement?: SubscriptionSource;
  readonly entitlementTimeoutMs?: number;
  readonly embedder: Embedder;
  readonly store: EncryptedIndexStore;
  readonly tenantId?: string;
  readonly rrf?: Partial<RrfConfig>;
  readonly bodyConfig?: SaihmBodySourceConfig;
  readonly bodyStore?: EncryptedBodyStore;
  readonly tierLatency?: { record(tier: Tier, ms: number): void };
  readonly reranker?: Reranker;
  readonly rerankK?: number;
  readonly rerankOnBody?: boolean;
  readonly rerankBodyWindowChars?: number;
  readonly onRerankFallback?: (err: unknown) => void;
  readonly queryExpansion?: boolean;
  readonly queryExpansionN?: number;
  readonly queryExpansionM?: number;
  readonly excludeNamespaces?: readonly Namespace[];
  readonly threadLifecycle?: boolean;
  readonly threadJoin?: boolean;
  readonly threadDemote?: DemoteMode;
  readonly threadPoolK?: number;
  readonly allowThreadPoolWiderThanRerank?: boolean;
  readonly threadMaxGroup?: number;
  readonly stampOf?: (cellId: string) => LifecycleStamp;
  readonly standingStore?: StandingSessionStore;
  readonly standingBodies?: BodySource;
  readonly standingLabelOf?: LabelLookup;
  readonly derivedStore?: {
    readonly onSourceErased: (cellId: string) => void | Promise<void>;
    readonly cascade?: (cellId: string) => Promise<{ readonly forgotten: readonly string[] }>;
    readonly lineageOf?: (cellId: string) => readonly string[] | undefined;
    readonly retirements?: () => ReadonlyMap<string, string>;
  };
  readonly derivedLineage?: {
    readonly lineageOf: (cellId: string) => readonly string[] | undefined;
    readonly forget?: (cellId: string) => void;
  };
  readonly audit?: AuditTrail;
  readonly agentIdHash?: string;
  readonly erasureFeed?: false | ErasureFeedOptions;
  readonly changeFeed?: false | ChangeFeedOptions;
  readonly warmStart?: WarmStart;
  readonly onErased?: (cellId: string) => void | Promise<void>;
  readonly reconcile?: false | ReconcileOptions;
  readonly writerLock?: false;
}

export interface StandingSessionStore extends StandingRecorder {
  readonly purge: (cellId: string) => void | Promise<void>;
}

interface StandingWiring {
  readonly store: StandingSessionStore;
  readonly index: ContentFingerprintIndex;
  readonly scope: FingerprintScope;
}

export interface WorkstreamOptions {
  readonly asOfEpoch?: number;
  readonly scope?: Scope;
  readonly freshnessOf?: FreshnessLookup;
  readonly nowEpoch?: number;
  readonly staleAfterHours?: number;
  readonly resume?: {
    readonly claims: readonly ResumeClaim[];
    readonly probes: Readonly<Record<string, Probe>>;
    readonly here?: string;
  };
}

export type WorkstreamAccount = ThreadAccount & { readonly resume?: ResumeReport };

export interface HistoryOptions {
  readonly maxK?: number;
  readonly scope?: Scope;
  readonly at?: readonly number[];
  readonly maxViews?: number;
}

export interface TierOptions {
  readonly nowEpoch: number;
  readonly scope?: Scope;
  readonly apply?: boolean;
}

export interface PagingOutcome {
  readonly promoted: number;
  readonly evicted: number;
  readonly failed: number;
}

export interface FleetOptions extends FleetPolicy {
  readonly scope?: Scope;
  readonly nowEpoch?: number;
  readonly clusters?: boolean;
}

export interface WatchOptions {
  readonly dir: string;
  readonly filename?: string;
  readonly debounceMs?: number;
  readonly pollMs?: number;
  readonly onError?: (err: unknown) => void;
}

export interface ErasureFeedOptions {
  readonly path?: string;
  readonly stateDir?: string;
  readonly pollMs?: number;
  readonly onError?: (err: unknown) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly now?: () => number;
  readonly watch?: boolean;
  readonly mapCellId?: (cellId: string) => readonly string[];
}

export interface ChangeFeedOptions {
  readonly path?: string;
  readonly pollMs?: number;
  readonly livenessMs?: number;
  readonly reconcileRetryMs?: number;
  readonly onChanged?: (cellId: string, version: { readonly seq: string; readonly commitment: string }) => void | Promise<void>;
  readonly ownReads?: boolean;
  readonly onError?: (err: unknown) => void;
  readonly timer?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly now?: () => number;
}

export type ChangeFeedStatus =
  | ({ readonly mode: "following"; readonly ownReads: OwnReadsStatus } & ChangeFeedFollowerStatus)
  | { readonly mode: "not-wired"; readonly reason: string };

export type WarmStartRestore =
  | { readonly outcome: "restored"; readonly snapshotId: string; readonly coversThrough: string; readonly rows: number }
  | { readonly outcome: "skipped"; readonly reason: string }
  | { readonly outcome: "cold"; readonly reason: string };

export type WarmStartStatus =
  | { readonly mode: "wired"; readonly restore: WarmStartRestore; readonly lastTake: TakeOutcome | null }
  | { readonly mode: "not-wired"; readonly reason: string };

export type OwnReadsStatus = ({ readonly mode: "by-id" } & OwnCellBodyStats) | { readonly mode: "by-label"; readonly reason: string };

export interface ReconcileOptions {
  readonly candidates: () => readonly ReconcileCandidate[] | Promise<readonly ReconcileCandidate[]>;
  readonly stateDir?: string;
  readonly withheld?: WithheldStore;
  readonly substrate?: SaihmReadPort;
  readonly atOpen?: boolean;
  readonly maxProbes?: number;
  readonly recallCap?: number;
  readonly listing?: boolean;
}

export type ReconciliationStatus =
  | {
      readonly mode: "configured";
      readonly last: ReconcileSummary | undefined;
      readonly withheld: readonly string[];
      readonly persisted: boolean;
      readonly storeFault?: string;
      readonly loadFault?: string;
      readonly foreignState?: { readonly writtenBy: string; readonly adopted: number; readonly dropped: number };
    }
  | { readonly mode: "opted-out" }
  | { readonly mode: "not-wired"; readonly reason: string };

export type ReleaseOutcome =
  | { readonly cellId: string; readonly reason: string; readonly outcome: "released"; readonly persisted: boolean; readonly fault?: string }
  | { readonly cellId: string; readonly reason: string; readonly outcome: "not-withheld" };

export type StateFileRole = "erasure-feed cursor" | "withheld set";

export interface StateDirLockStatus {
  readonly path: string;
  readonly holds: readonly StateFileRole[];
  readonly sharedInProcess: number;
}

export type WriterLockStatus =
  | { readonly mode: "held"; readonly path: string; readonly pid: number; readonly host: string; readonly startedAt: string; readonly sharedInProcess: number; readonly stateDirs?: readonly StateDirLockStatus[] }
  | { readonly mode: "released"; readonly path: string; readonly stateDirs?: readonly Omit<StateDirLockStatus, "sharedInProcess">[] }
  | { readonly mode: "opted-out" };

interface HeldLocks {
  readonly index: WriterLock;
  readonly stateDirs: { readonly lock: WriterLock; readonly holds: readonly StateFileRole[] }[];
}

interface StateFilePlan {
  readonly feedCursor?: string;
  readonly withheld?: string;
}

interface ResolvedReconcile {
  readonly candidates: ReconcileOptions["candidates"];
  readonly substrate: SaihmReadPort;
  readonly atOpen: boolean;
  readonly maxProbes: number;
  readonly recallCap: number;
  readonly listing: boolean;
  readonly withheld: WithheldStore;
  readonly persisted: boolean;
}

export type ErasureFeedStatus =
  | ({ readonly mode: "watching" } & FeedWatcherStatus)
  | { readonly mode: "opted-out" }
  | { readonly mode: "not-wired"; readonly reason: string };

export interface RerankStats {
  readonly enabled: boolean;
  readonly attempts: number;
  readonly fallbacks: number;
}

export interface ThreadStats extends Omit<ThreadLifecycleStats, "config"> {
  readonly enabled: boolean;

  readonly config: ThreadLifecycleEffective | null;
}

export class MemorySession {
  private watcher: IndexWatcher | undefined;
  private withheldNow = new Set<string>();
  private lastReconcile: ReconcileSummary | undefined;
  private reconcileChain: Promise<unknown> = Promise.resolve();
  private withheldFault: string | undefined;
  private withheldLoadFaultOnce: string | undefined;
  private withheldLoadNote: string | undefined;
  private withheldForeign: { readonly writtenBy: string; readonly adopted: number; readonly dropped: number } | undefined;
  private withheldLoadFault: string | undefined;
  private changeFollower: ChangeFeedFollower | undefined;
  private changeUnwired: ChangeFeedStatus | undefined;
  private ownReads: OwnCellBodySource | undefined;
  private ownReadsOff = "not wired";
  private warmStartWiring: { readonly client: WarmStart; readonly identity: string; readonly restore: WarmStartRestore } | undefined;
  private warmStartOff = "not requested — pass warmStart (a snapshot client) to restore and take snapshots";
  private lastWarmTake: TakeOutcome | null = null;
  private writerLocks: HeldLocks | undefined;
  private writerLocksReleased: Extract<WriterLockStatus, { mode: "released" }> | undefined;
  private closed = false;
  private readonly withheldSaves = new Set<Promise<void>>();
  private withheldGuard: WriterLock | undefined;

  private constructor(
    readonly retriever: SemanticRetriever,
    readonly bodies: CachingBodySource,
    readonly answerRetriever: RankRetriever,
    readonly bus: ErasureBus,
    private readonly detector: ErasureDetector,
    private readonly warm: WarmIndex,
    private readonly port: SaihmReadPort,
    private readonly persistent: PersistentBodySource | undefined,
    private readonly bodyStore: EncryptedBodyStore | undefined,
    private readonly rerankRetriever: RerankingRankRetriever | undefined,
    private readonly threadRetriever: ThreadLifecycleRankRetriever | undefined,
    private readonly standingWiring: StandingWiring | undefined,
    private readonly labelMap: ReadonlyMap<string, string>,
    private readonly stampLookup: StampLookup,
    private readonly lineageLookup: (cellId: string) => readonly string[] | undefined,
    private readonly embedder: Embedder,
    private readonly audit: AuditTrail | undefined,
    private readonly feedWatcher: FeedWatcher | undefined,
    private readonly feedUnwired: ErasureFeedStatus | undefined,
    private readonly reconcileCfg: ResolvedReconcile | undefined,
    private readonly reconcileUnwired: ReconciliationStatus | undefined,
  ) {}

  static _create(
    retriever: SemanticRetriever,
    bodies: CachingBodySource,
    answerRetriever: RankRetriever,
    bus: ErasureBus,
    detector: ErasureDetector,
    warm: WarmIndex,
    port: SaihmReadPort,
    persistent: PersistentBodySource | undefined,
    bodyStore: EncryptedBodyStore | undefined,
    rerankRetriever: RerankingRankRetriever | undefined,
    threadRetriever: ThreadLifecycleRankRetriever | undefined,
    standingWiring: StandingWiring | undefined,
    labelMap: ReadonlyMap<string, string>,
    stampLookup: StampLookup,
    lineageLookup: (cellId: string) => readonly string[] | undefined,
    embedder: Embedder,
    audit: AuditTrail | undefined,
    feedWatcher: FeedWatcher | undefined,
    feedUnwired: ErasureFeedStatus | undefined,
    reconcileCfg: ResolvedReconcile | undefined,
    reconcileUnwired: ReconciliationStatus | undefined,
  ): MemorySession {
    return new MemorySession(
      retriever, bodies, answerRetriever, bus, detector, warm, port, persistent, bodyStore,
      rerankRetriever, threadRetriever, standingWiring, labelMap, stampLookup, lineageLookup, embedder, audit,
      feedWatcher, feedUnwired, reconcileCfg, reconcileUnwired,
    );
  }

  scope(spec: ScopeSpec): Scope {
    const base = scopeFrom(spec, {
      stampOf: this.stampLookup,
      namespaceOf: (id) => {
        const label = this.labelMap.get(id);
        return label === undefined ? undefined : parseLabel(label).namespace;
      },
    });
    return withLineage(base, {
      isDerived: (id) => isDerivedLabel(this.labelMap.get(id) ?? ""),
      lineageOf: this.lineageLookup,
    });
  }

  census(scope: Scope): { readonly admitted: number; readonly excluded: number; readonly total: number } {
    return this.retriever.census(scope);
  }

  threads(opts: { readonly scope?: Scope } = {}): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const row of this.retriever.enumerate(opts.scope ?? composeScopes())) {
      const t = this.stampLookup(row.cellId).thread;
      if (t !== undefined) out.set(t, (out.get(t) ?? 0) + 1);
    }
    return out;
  }

  thread(slug: string, opts: WorkstreamOptions = {}): WorkstreamAccount {
    const threadScope = this.scope({ threads: [slug] });
    const scope = opts.scope === undefined ? threadScope : composeScopes(threadScope, opts.scope);
    const asOf = opts.asOfEpoch !== undefined ? { asOfEpoch: opts.asOfEpoch } : undefined;
    const rows = this.retriever.enumerate(scope, asOf);
    const scoped = opts.scope === undefined ? undefined
      : { name: opts.scope.name, notAdmitted: this.retriever.enumerate(threadScope, asOf).length - rows.length };
    const anyThread: Scope = { name: "any-thread", admits: (id) => this.stampLookup(id).thread !== undefined };
    const corpusHasThreadStamps = this.retriever.census(anyThread).admitted > 0;
    const account = assembleThread(slug, rows, {
      stampOf: this.stampLookup,
      corpusHasThreadStamps,
      labelOf: (id) => this.labelMap.get(id),
      ...(opts.freshnessOf !== undefined ? { freshnessOf: opts.freshnessOf } : {}),
      ...(opts.nowEpoch !== undefined ? { nowEpoch: opts.nowEpoch } : {}),
      ...(opts.staleAfterHours !== undefined ? { staleAfterHours: opts.staleAfterHours } : {}),
    });
    const described: WorkstreamAccount = scoped === undefined ? account : { ...account, scoped };
    if (opts.resume === undefined) return described;
    const report = verifyResume(
      opts.resume.claims,
      opts.resume.probes,
      opts.resume.here !== undefined ? { here: opts.resume.here } : {},
    );
    return { ...described, resume: report };
  }

  async history(query: string, opts: HistoryOptions = {}): Promise<HistoryReport> {
    const queryVector = await this.retriever.embedQuery(query);
    const base = {
      ...(opts.maxK !== undefined ? { maxK: opts.maxK } : {}),
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      queryVector,
    };
    const current = await this.retriever.selectDetailed(query, base);
    const epochs = opts.at !== undefined ? [...new Set(opts.at)] : epochsFromHits(current);
    const maxViews = Number.isInteger(opts.maxViews) && (opts.maxViews as number) >= 0 ? (opts.maxViews as number) : 32;
    if (epochs.length > maxViews) {
      throw new Error(`history: ${epochs.length} as-of views exceed maxViews=${maxViews} — refusing to truncate a timeline; raise maxViews or pass fewer epochs`);
    }
    const views: { asOfEpoch: number; hits: RankedHit[] }[] = [];
    for (const asOfEpoch of epochs) views.push({ asOfEpoch, hits: await this.retriever.selectDetailed(query, { ...base, asOfEpoch }) });
    const scopeOpt = opts.scope !== undefined ? { scope: opts.scope } : {};
    return assembleHistory({
      query,
      current,
      views,
      reason: opts.at !== undefined ? "caller" : "arrival",
      knowableAt: (cellId, asOfEpoch) => this.retriever.vetCandidates([cellId], { asOfEpoch, ...scopeOpt }).length === 1,
      labelOf: (id) => this.labelMap.get(id),
      threadOf: (id) => this.stampLookup(id).thread,
    });
  }

  async fleet(opts: FleetOptions = {}): Promise<FleetReport> {
    const rows = this.retriever.enumerate(opts.scope ?? composeScopes());
    const epochOf = new Map<string, number>();
    for (const r of rows) if (r.ingestEpoch > 0) epochOf.set(r.cellId, r.ingestEpoch);
    const fleetRows: FleetRow[] = rows.map((r) => {
      const label = this.labelMap.get(r.cellId);
      const thread = this.stampLookup(r.cellId).thread;
      return {
        cellId: r.cellId,
        ...(r.ingestEpoch > 0 ? { ingestEpoch: r.ingestEpoch } : {}),
        namespace: label === undefined ? "unknown" : parseLabel(label).namespace,
        ...(thread !== undefined ? { thread } : {}),
        ...(r.supersededBy !== undefined ? { supersededBy: r.supersededBy } : {}),
        ...(r.retiredBy !== undefined ? { retiredBy: r.retiredBy } : {}),
        ...(r.derived === true ? { derived: true as const } : {}),
      };
    });
    let clusters: RedundancyCluster[] | undefined;
    if (opts.clusters !== false) {
      const entries: IndexEntry[] = rows.map((r) => ({ cellId: r.cellId, label: this.labelMap.get(r.cellId) ?? "", epoch: r.ingestEpoch, byteSize: 0, tier: "index", forgotten: false }));
      clusters = (await Consolidator.build(entries, this.embedder)).redundancyClusters();
    }
    const policy: FleetPolicy = {
      ...(opts.thinBelow !== undefined ? { thinBelow: opts.thinBelow } : {}),
      ...(opts.staleAfterHours !== undefined ? { staleAfterHours: opts.staleAfterHours } : {}),
      ...(opts.driftWindowHours !== undefined ? { driftWindowHours: opts.driftWindowHours } : {}),
    };
    return assembleFleetReport({
      rows: fleetRows,
      ...(clusters !== undefined ? { clusters } : {}),
      ...(opts.nowEpoch !== undefined ? { nowEpoch: opts.nowEpoch } : {}),
      policy,
      epochOf: (id) => epochOf.get(id),
    });
  }

  async standing(
    question: string,
    retrievedCellIds: readonly string[],
    nowEpochMs: number,
    cfg: StandingRecallConfig = {},
  ): Promise<StandingSurface> {
    if (!this.standingWiring) {
      throw new Error(
        "standing() requires a `standingStore` at openMemorySession. Without one there is no store " +
          "to audit against and no erasure subscription for the answers it would write, so an empty " +
          "result here would be indistinguishable from 'nothing matched'.",
      );
    }
    const { store, index } = this.standingWiring;
    return surfaceStanding(question, retrievedCellIds, { store, index }, nowEpochMs, cfg);
  }

  get standingStats(): {
    readonly enabled: boolean;
    readonly refreshes: number;
    readonly bodyFailures: number;
    readonly fingerprintScope: FingerprintScope;
  } {
    if (!this.standingWiring) {
      return { enabled: false, refreshes: 0, bodyFailures: 0, fingerprintScope: "label" };
    }
    const { refreshes, bodyFailures } = this.standingWiring.index.stats;
    return { enabled: true, refreshes, bodyFailures, fingerprintScope: this.standingWiring.scope };
  }

  async warmBodies(opts: WarmOptions = {}): Promise<WarmResult> {
    if (!this.persistent || !this.bodyStore) {
      return {
        scanned: 0, alreadyWarm: 0, ineligible: 0, targeted: 0, consumed: 0,
        filled: 0, skippedPartial: 0, errors: 0,
        remaining: 0, stoppedReason: "complete", elapsedMs: 0,
      };
    }
    return new CorpusWarmer(this.port, this.bodyStore, this.persistent).warm(opts);
  }

  proactiveInjector(
    cfg: { budget?: InjectionBudget; deriveCue?: CueDeriver; relevanceFloor?: number; tokenEstimate?: TokenEstimate; onResult?: (result: InjectionResult) => void } = {},
  ): ProactiveInjector {
    const audit = this.audit;
    const onResult =
      audit === undefined
        ? cfg.onResult
        : (result: InjectionResult) => {
            audit.recordInjection(result);
            cfg.onResult?.(result);
          };
    return new ProactiveInjector(this.answerRetriever, this.bodies, { ...cfg, ...(onResult !== undefined ? { onResult } : {}) });
  }

  get auditTrail(): AuditTrail | undefined {
    return this.audit;
  }

  compliance(opts: Omit<ComplianceOptions, "dropped" | "wired"> = {}): ComplianceReport {
    if (this.audit === undefined) throw new Error("compliance: no audit trail configured — pass `audit: new AuditTrail(...)` at open");
    const feed = this.erasureFeed;
    const feedNotes = feed.mode === "watching" ? [] : [`erasure feed ${feed.mode}${feed.mode === "not-wired" ? `: ${feed.reason}` : ""} — protocol forgets reach this session only through checkErasures()/watch() or session.bus.publish()`];
    const recon = this.reconciliation;
    if (recon.mode !== "configured") feedNotes.push(`reconciliation ${recon.mode}${recon.mode === "not-wired" ? `: ${recon.reason}` : ""} — a copied row outlives the cell it copies when the substrate's client fails to write a line`);
    return assembleComplianceReport(this.audit.events(), { ...opts, dropped: this.audit.dropped, wired: { erasure: true, injection: true, paging: true, feed: this.feedWatcher !== undefined, reconciliation: this.reconcileCfg !== undefined }, feedWiring: feed.mode, notes: feedNotes });
  }

  async tiers(policy: TierPolicy, opts: TierOptions): Promise<TierPlan & { readonly applied?: PagingOutcome }> {
    if (opts.apply === true && this.audit === undefined) throw new Error("tiers: apply requires an audit trail — no audit trail configured, and paging nobody can observe is silent state");
    const rows = this.retriever.enumerate(opts.scope ?? composeScopes());
    const accesses = new Map<string, { count: number; lastEpoch?: number }>();
    if (this.audit !== undefined) {
      for (const e of this.audit.events()) {
        if (e.kind !== "injection") continue;
        for (const id of e.injected) {
          const cur = accesses.get(id) ?? { count: 0 };
          const last = e.atEpoch !== undefined && (cur.lastEpoch === undefined || e.atEpoch > cur.lastEpoch) ? e.atEpoch : cur.lastEpoch;
          accesses.set(id, { count: cur.count + 1, ...(last !== undefined ? { lastEpoch: last } : {}) });
        }
      }
    }
    const signals: TierSignals[] = rows.map((r) => {
      const label = this.labelMap.get(r.cellId);
      const parsed = label === undefined ? undefined : parseLabel(label);
      return {
        cellId: r.cellId,
        ...(r.ingestEpoch > 0 ? { ingestEpoch: r.ingestEpoch } : {}),
        salient: parsed !== undefined && (parsed.salienceFloor || parsed.decayExempt),
        ...(this.audit !== undefined ? { accesses: accesses.get(r.cellId) ?? { count: 0 } } : {}),
      };
    });
    let warm = new Set<string>();
    const extraNotes: string[] = [];
    if (this.bodyStore !== undefined) {
      try {
        warm = new Set(await this.bodyStore.list());
      } catch (e) {
        extraNotes.push(`at-rest store could not be listed (${(e as Error).message}): warm membership read as empty`);
      }
    } else {
      extraNotes.push("no body store: the warm tier is not configured; promotions to warm cannot be applied");
    }
    const hot = new Set(rows.filter((r) => this.bodies.has(r.cellId)).map((r) => r.cellId));
    const base = planTiers(signals, { hot, warm }, policy, opts.nowEpoch, this.audit !== undefined);
    const plan: TierPlan = extraNotes.length > 0 ? { ...base, notes: [...base.notes, ...extraNotes] } : base;
    if (opts.apply !== true) return plan;
    const audit = this.audit!;
    let promoted = 0;
    let evicted = 0;
    let failed = 0;
    const presence = async (id: string): Promise<AtRestPresence> => (this.bodyStore === undefined ? "absent" : await this.bodyStore.presence(id));
    for (const a of plan.promotions) {
      let ok = false;
      try {
        if (a.to === "hot") ok = (await this.bodies.fetchByIds([a.cellId])).length === 1 && this.bodies.has(a.cellId);
        else if (this.persistent !== undefined) ok = (await this.persistent.fetchByIds([a.cellId])).length === 1 && (await presence(a.cellId)) === "present";
      } catch {
        ok = false;
      }
      audit.recordPaging(a, ok ? "applied" : "failed", opts.nowEpoch);
      if (ok) promoted++;
      else failed++;
    }
    for (const a of plan.evictions) {
      let ok = false;
      try {
        let before = await presence(a.cellId);
        if (a.to === "warm" && a.from === "hot" && before === "absent" && this.persistent !== undefined) {
          const since = this.persistent.stamp();
          const resident = this.bodies.peek(a.cellId);
          if (resident !== undefined && (await this.persistent.persist(resident, since)) === "filled") before = await presence(a.cellId);
        }
        if (!(a.to === "warm" && before !== "present") && !(a.to === "cold" && before === "unknown")) {
          if (a.from === "hot") this.bodies.evict(a.cellId);
          if (a.to === "cold" && before === "present") await this.bodyStore?.delete(a.cellId);
          const after = await presence(a.cellId);
          ok = !this.bodies.has(a.cellId) && after === (a.to === "cold" ? "absent" : "present");
        }
      } catch {
        ok = false;
      }
      audit.recordPaging(a, ok ? "applied" : "failed", opts.nowEpoch);
      if (ok) evicted++;
      else failed++;
    }
    return { ...plan, applied: { promoted, evicted, failed } };
  }

  get bodyStats(): { readonly ram: CacheStats; readonly atRest?: PersistentBodyStats & { readonly ineligible: number; readonly live: number } } {
    const ram = this.bodies.stats;
    if (this.persistent === undefined || this.bodyStore === undefined) return { ram };
    const store = this.bodyStore;
    let ineligible = 0;
    for (const id of this.labelMap.keys()) if (!store.accepts(id)) ineligible++;
    return { ram, atRest: { ...this.persistent.stats, ineligible, live: this.labelMap.size } };
  }

  get buildStats() {
    return this.warm.stats;
  }

  get rerankStats(): RerankStats {
    return this.rerankRetriever
      ? { enabled: true, ...this.rerankRetriever.stats }
      : { enabled: false, attempts: 0, fallbacks: 0 };
  }

  get threadStats(): ThreadStats {
    return this.threadRetriever
      ? { enabled: true, ...this.threadRetriever.stats }
      : { enabled: false, attempts: 0, threadsJoined: 0, demoted: 0, stampsResolved: 0, config: null };
  }

  async checkErasures(): Promise<string[]> {
    const all: string[] = [];
    const MAX_PASSES = 32;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const erased = await this.detector.checkOnce();
      if (erased.length === 0) return all;
      all.push(...erased);
    }
    throw new Error(
      `checkErasures: still detecting erasures after ${MAX_PASSES} passes (${all.length} so far) — a listener keeps erasing; refusing to report a non-quiescent index as checked`,
    );
  }

  watch(opts: WatchOptions): void {
    this.watcher?.close();
    const cfg: {
      dir: string;
      filename?: string;
      debounceMs?: number;
      pollMs?: number;
      onError?: (err: unknown) => void;
    } = { dir: opts.dir };
    if (opts.filename !== undefined) cfg.filename = opts.filename;
    if (opts.debounceMs !== undefined) cfg.debounceMs = opts.debounceMs;
    if (opts.pollMs !== undefined) cfg.pollMs = opts.pollMs;
    if (opts.onError !== undefined) cfg.onError = opts.onError;
    this.watcher = new IndexWatcher(cfg, () => this.checkErasures());
    this.watcher.start();
  }

  _attachChangeFeed(follower: ChangeFeedFollower | undefined, unwired: ChangeFeedStatus | undefined): void {
    this.changeFollower = follower;
    this.changeUnwired = unwired;
  }

  _attachOwnReads(own: OwnCellBodySource | undefined, off: string): void {
    this.ownReads = own;
    this.ownReadsOff = off;
  }

  _attachWarmStart(wiring: { readonly client: WarmStart; readonly identity: string; readonly restore: WarmStartRestore } | undefined, off: string): void {
    this.warmStartWiring = wiring;
    this.warmStartOff = off;
  }

  get warmStart(): WarmStartStatus {
    const w = this.warmStartWiring;
    return w === undefined ? { mode: "not-wired", reason: this.warmStartOff } : { mode: "wired", restore: w.restore, lastTake: this.lastWarmTake };
  }

  async takeWarmStart(): Promise<TakeOutcome> {
    const w = this.warmStartWiring;
    if (w === undefined) return { ok: false, reason: `warm start is not wired: ${this.warmStartOff}` };
    if (this.closed) return { ok: false, reason: "the session is closed" };
    const coversThrough = this.changeFollower?.appliedCursor() ?? null;
    let bytes: Uint8Array;
    try {
      bytes = encodeIndexPart(this.warm.currentRows(), this.warm.embeddingSpace);
    } catch (e) {
      return { ok: false, reason: e instanceof IndexPartError ? `the index part could not be built: ${e.message}` : "the index part could not be built" };
    }
    const out = await takeSnapshot(w.client, { agentIdHash: w.identity, coversThrough, createdAt: new Date().toISOString(), parts: [{ name: INDEX_PART_NAME, bytes }] });
    this.lastWarmTake = out;
    return out;
  }

  get changeFeed(): ChangeFeedStatus {
    if (this.changeFollower === undefined) return this.changeUnwired ?? { mode: "not-wired", reason: "no change feed follower" };
    const by = this.ownReads?.stats;
    const ownReads: OwnReadsStatus = by === undefined ? { mode: "by-label", reason: this.ownReadsOff } : by.stopped !== null ? { mode: "by-label", reason: by.stopped } : { mode: "by-id", ...by };
    return { mode: "following", ownReads, ...this.changeFollower.status };
  }

  async syncChanges(): Promise<void> {
    if (this.changeFollower === undefined) {
      const st = this.changeFeed;
      throw new Error(`syncChanges: the change feed is ${st.mode}${st.mode === "not-wired" ? `: ${st.reason}` : ""}`);
    }
    await this.changeFollower.pull();
  }

  noteOwnWrite(receipt: { readonly cellId: string; readonly seq?: string; readonly commitment?: string }): void {
    this.changeFollower?.noteOwnWrite(receipt);
  }

  async _dropCachedBody(cellId: string, seq?: string): Promise<void> {
    this.ownReads?.supersede(cellId);
    this.bodies.supersede(cellId, seq);
    await this.persistent?.supersede(cellId, seq);
  }

  _attachWriterLocks(locks: HeldLocks | undefined): void {
    this.writerLocks = locks;
    if (locks !== undefined && this.reconcileCfg?.persisted === true) {
      this.withheldGuard = locks.stateDirs.find((s) => s.holds.includes("withheld set"))?.lock ?? locks.index;
    }
  }

  get writerLock(): WriterLockStatus {
    const l = this.writerLocks;
    if (l !== undefined) {
      const i = l.index;
      return {
        mode: "held", path: i.path, pid: i.holder.pid, host: i.holder.host, startedAt: i.holder.startedAt, sharedInProcess: i.sharedInProcess,
        ...(l.stateDirs.length > 0 ? { stateDirs: l.stateDirs.map((s) => ({ path: s.lock.path, holds: s.holds, sharedInProcess: s.lock.sharedInProcess })) } : {}),
      };
    }
    return this.writerLocksReleased ?? { mode: "opted-out" };
  }

  get erasureFeed(): ErasureFeedStatus {
    if (this.feedWatcher === undefined) return this.feedUnwired ?? { mode: "not-wired", reason: "no feed watcher" };
    return { mode: "watching", ...this.feedWatcher.status };
  }

  async checkFeed(): Promise<number> {
    if (this.feedWatcher === undefined) {
      const st = this.erasureFeed;
      throw new Error(`checkFeed: the erasure feed is ${st.mode}${st.mode === "not-wired" ? `: ${st.reason}` : ""}`);
    }
    return this.feedWatcher.runOnce();
  }

  get ingestStats(): IngestStats {
    return this.warm.ingest;
  }

  get reconciliation(): ReconciliationStatus {
    if (this.reconcileCfg === undefined) return this.reconcileUnwired ?? { mode: "not-wired", reason: "no reconciliation configured" };
    return {
      mode: "configured", last: this.lastReconcile, withheld: [...this.withheldNow].sort(), persisted: this.reconcileCfg.persisted,
      ...(this.withheldFault !== undefined ? { storeFault: this.withheldFault } : {}),
      ...(this.withheldLoadFault !== undefined ? { loadFault: this.withheldLoadFault } : {}),
      ...(this.withheldForeign !== undefined ? { foreignState: this.withheldForeign } : {}),
    };
  }

  async release(cellId: string, reason: string): Promise<ReleaseOutcome> {
    if (typeof cellId !== "string" || cellId.length === 0) throw new TypeError("release: a cell id is required");
    if (typeof reason !== "string" || reason.trim().length === 0) throw new TypeError("release: a reason is required — the trail records who lifted a doubt and why");
    if (this.reconcileCfg === undefined) {
      const st = this.reconciliation;
      throw new Error(`release: reconciliation is ${st.mode}${st.mode === "not-wired" ? `: ${st.reason}` : ""}`);
    }
    const run = this.reconcileChain.then(() => this.runRelease(cellId, reason.trim()));
    this.reconcileChain = run.catch(() => {});
    return run;
  }

  private async runRelease(cellId: string, reason: string): Promise<ReleaseOutcome> {
    if (!this.withheldNow.has(cellId)) {
      this.audit?.recordRelease({ cellId, reason, outcome: "not-withheld" });
      return { cellId, reason, outcome: "not-withheld" };
    }
    this.withheldNow.delete(cellId);
    this.retriever.setWithheld(this.withheldNow);
    const persisted = await this.persistWithheld();
    const fault = this.withheldFault;
    this.audit?.recordRelease({ cellId, reason, outcome: "released", persisted, ...(fault !== undefined ? { storeFault: fault } : {}) });
    return { cellId, reason, outcome: "released", persisted, ...(fault !== undefined ? { fault } : {}) };
  }

  private async persistWithheld(): Promise<boolean> {
    const cfg = this.reconcileCfg;
    if (cfg === undefined) return false;
    if (this.closed) {
      this.withheldFault = "the session is closed: no write lands after its writer locks go — this change is in memory only";
      return false;
    }
    if (this.withheldGuard !== undefined && !this.withheldGuard.newestInProcess) {
      this.withheldFault = "a newer session on this index holds the withheld set (the hot swap): this change is in memory only — make it on the newer session";
      return false;
    }
    try {
      const save = cfg.withheld.save([...this.withheldNow].sort());
      this.withheldSaves.add(save);
      try {
        await save;
      } finally {
        this.withheldSaves.delete(save);
      }
      this.withheldFault = undefined;
      return cfg.persisted;
    } catch (e) {
      this.withheldFault = `withheld store write failed: ${e instanceof Error ? e.message : String(e)} — doubts are per process until a write succeeds`;
      return false;
    }
  }

  async _loadWithheld(): Promise<void> {
    const cfg = this.reconcileCfg;
    if (cfg === undefined) return;
    const file = cfg.withheld instanceof FileWithheldStore ? cfg.withheld : undefined;
    if (file !== undefined && this.writerLocks === undefined) {
      try {
        await file.probeWritable();
      } catch (pe) {
        this.withheldFault = `withheld store directory not writable at open: ${pe instanceof Error ? pe.message : String(pe)} — doubts are per process until a write succeeds`;
      }
    }
    try {
      const ids = await cfg.withheld.load();
      const writtenBy = file?.lastLoadedOwner;
      const self = file?.opts.owner;
      const foreign = typeof writtenBy === "string" && self !== undefined && writtenBy !== self ? writtenBy : undefined;
      const held = (ids ?? []).filter((id) => this.retriever.holds(id));
      const dropped = (ids ?? []).length - held.length;
      if (foreign !== undefined) this.withheldForeign = { writtenBy: foreign, adopted: held.length, dropped };
      if (ids !== undefined && ids.length > 0) {
        this.withheldNow = new Set(held);
        this.retriever.setWithheld(this.withheldNow);
        if (dropped > 0) {
          this.withheldLoadNote =
            foreign !== undefined
              ? `${dropped} persisted doubt(s) were written by another index (${foreign}) and name rows this index does not hold: dropped — they were that index's doubts, not rows this index held; a state directory belongs to one deployment`
              : file !== undefined && writtenBy === null
                ? `${dropped} persisted doubt(s) name rows this index does not hold: dropped — the file names no owner (written by a previous release), so they may have been another index's doubts rather than this index's stale rows`
                : file === undefined
                  ? `${dropped} persisted doubt(s) name rows this index does not hold: dropped — the store records no writer, so whose doubts they were is unknown`
                  : `${dropped} persisted doubt(s) named rows this index no longer holds: dropped`;
        }
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      let quarantined: string | undefined;
      try {
        quarantined = await cfg.withheld.quarantine?.();
      } catch (qe) {
        quarantined = undefined;
        this.withheldFault = `withheld store: the unreadable file could not be quarantined: ${qe instanceof Error ? qe.message : String(qe)}`;
      }
      this.withheldLoadFault = `withheld store unreadable at open: ${why} — every doubt held before this open is LOST${quarantined !== undefined ? ` (file moved to ${quarantined})` : ""}; every candidate is re-checked, and evidence re-raises a doubt only for a row still named as a candidate`;
      this.withheldLoadFaultOnce = this.withheldLoadFault;
      this.audit?.recordWithheldLost({ reason: this.withheldLoadFault, ...(quarantined !== undefined ? { quarantined } : {}) });
    }
  }

  readonly _onWithheldErased = async (cellId: string): Promise<void> => {
    if (!this.withheldNow.delete(cellId)) return;
    this.retriever.setWithheld(this.withheldNow);
    const persisted = await this.persistWithheld();
    this.audit?.recordWithheldErased({ cellId, persisted, ...(this.withheldFault !== undefined ? { storeFault: this.withheldFault } : {}) });
  };

  async reconcile(): Promise<ReconcileSummary> {
    if (this.reconcileCfg === undefined) {
      const st = this.reconciliation;
      throw new Error(`reconcile: reconciliation is ${st.mode}${st.mode === "not-wired" ? `: ${st.reason}` : ""}`);
    }
    const cfg = this.reconcileCfg;
    const run = this.reconcileChain.then(() => this.runReconcile(cfg));
    this.reconcileChain = run.catch(() => {});
    return run;
  }

  private async runReconcile(cfg: ResolvedReconcile): Promise<ReconcileSummary> {
    const listedCandidates = await cfg.candidates();
    const seenIds = new Set<string>();
    const all = listedCandidates.filter((c) => (seenIds.has(c.cellId) ? false : (seenIds.add(c.cellId), true)));
    const held = all.filter((c) => this.retriever.holds(c.cellId));
    const notes: string[] = [];
    if (all.length < listedCandidates.length) notes.push(`${listedCandidates.length - all.length} duplicate candidate(s) ignored (first occurrence kept)`);
    if (held.length < all.length) notes.push(`${all.length - held.length} candidate(s) name rows this index does not hold: skipped`);
    let method: ReconcileSummary["method"] = "none";
    const decisions: ReconcileDecision[] = [];
    let deferred = 0;
    let entries: ReadonlyMap<string, IndexEntry> | undefined;
    try {
      const listed = await cfg.substrate.readIndex();
      entries = new Map(listed.map((e) => [e.cellId.toLowerCase(), e] as const));
    } catch {
      entries = undefined;
    }
    let listingComplete = false;
    if (entries === undefined && cfg.listing && cfg.substrate.listVersionsPage !== undefined) {
      const substrate = cfg.substrate;
      const listing = await collectListing((after) => substrate.listVersionsPage!(after));
      if (listing.complete) {
        listingComplete = true;
        method = "listing";
        for (const c of held) decisions.push(decideFromListing(c as ListingCandidate, listing));
      } else {
        notes.push(`the version listing was incomplete (${listing.incompleteReason ?? "no reason given"}): probed instead; it ends nothing`);
      }
    }
    if (entries !== undefined) {
      method = "index";
      for (const c of held) decisions.push(decideFromIndex(c, entries));
    } else if (!listingComplete) {
      method = "recall";
      const probed = held.slice(0, Math.max(0, cfg.maxProbes));
      deferred = held.length - probed.length;
      for (const c of probed) {
        if (c.probe === undefined || c.probe.trim().length === 0) {
          decisions.push(decideFromProbe(c, undefined));
          continue;
        }
        let r: ProbeResult;
        try {
          if (cfg.substrate.recallByQueryWithMeta !== undefined) {
            const a = await cfg.substrate.recallByQueryWithMeta(c.probe);
            r = { ok: true, bodies: a.bodies, cap: cfg.recallCap, ...(a.servedBy !== undefined ? { servedBy: a.servedBy } : {}) };
          } else {
            r = { ok: true, bodies: await cfg.substrate.recallByQuery(c.probe), cap: cfg.recallCap };
          }
        } catch (e) {
          r = { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
        decisions.push(decideFromProbe(c, r));
      }
    }
    const erased = decisions.filter((d) => d.verdict === "erased").map((d) => d.cellId);
    const suspect = decisions.filter((d) => d.verdict === "suspect").map((d) => d.cellId);
    const live = decisions.filter((d) => d.verdict === "live").map((d) => d.cellId);
    const restored = live.filter((id) => this.withheldNow.has(id));
    const next = new Set(this.withheldNow);
    for (const id of live) next.delete(id);
    for (const id of erased) next.delete(id);
    for (const id of suspect) next.add(id);
    this.withheldNow = next;
    this.retriever.setWithheld(next);
    const persisted = await this.persistWithheld();
    if (erased.length > 0) await this.bus.publish(erased);
    if (restored.length > 0) notes.push(`${restored.length} withheld row(s) RESTORED: found again on the substrate`);
    let loadFault: string | undefined;
    let loadNote: string | undefined;
    if (this.withheldLoadFaultOnce !== undefined) {
      loadFault = this.withheldLoadFaultOnce;
      notes.push(loadFault);
      this.withheldLoadFaultOnce = undefined;
    }
    if (this.withheldLoadNote !== undefined) {
      loadNote = this.withheldLoadNote;
      notes.push(loadNote);
      this.withheldLoadNote = undefined;
    }
    const storeFault = this.withheldFault;
    if (!persisted && cfg.persisted && storeFault !== undefined) notes.push(storeFault);
    const summary = summarize(method, decisions, deferred, notes);
    this.audit?.recordReconcile({ method, checked: summary.checked, live: summary.live, erased, suspect, restored, unverifiable: summary.unverifiable, deferred, withheld: [...this.withheldNow].sort(), persisted, ...(storeFault !== undefined ? { storeFault } : {}), ...(loadFault !== undefined ? { loadFault } : {}), ...(loadNote !== undefined ? { loadNote } : {}) });
    this.lastReconcile = summary;
    return summary;
  }

  async flush(): Promise<void> {
    await this.warm.flush();
  }

  async close(): Promise<void> {
    this.retriever.fence();
    this.bodies.fence();
    const indexWatcher = this.watcher;
    indexWatcher?.close();
    this.watcher = undefined;
    this.feedWatcher?.close();
    this.changeFollower?.close();
    await this.changeFollower?.settled();
    await this.feedWatcher?.settled();
    await indexWatcher?.settled();
    for (let chain = this.reconcileChain; ; chain = this.reconcileChain) {
      await chain;
      if (chain === this.reconcileChain) break;
    }
    this.closed = true;
    await Promise.allSettled([...this.withheldSaves]);
    await this.warm.flush();
    const l = this.writerLocks;
    if (l !== undefined) {
      this.writerLocks = undefined;
      this.writerLocksReleased = { mode: "released", path: l.index.path, ...(l.stateDirs.length > 0 ? { stateDirs: l.stateDirs.map((s) => ({ path: s.lock.path, holds: s.holds })) } : {}) };
      await releaseLocks(l);
    }
  }
}

export async function openMemorySession(opts: OpenMemorySessionOptions): Promise<MemorySession> {
  const entitlement = await checkEntitlement(entitlementSource(opts), opts.entitlementTimeoutMs !== undefined ? { timeoutMs: opts.entitlementTimeoutMs } : {});
  const plan = planStateFiles(opts);
  if (opts.writerLock === false) return openMemorySessionLocked(opts, plan, undefined, entitlement);
  const indexDir = await canonicalLockDir(opts.store.dir);
  const locks: HeldLocks = { index: await acquireWriterLock(opts.store.dir, { owner: indexDir }), stateDirs: [] };
  try {
    for (const g of await stateDirsOutside(plan, indexDir)) locks.stateDirs.push({ lock: await acquireWriterLock(g.dir, { owner: indexDir }), holds: g.holds });
    return await openMemorySessionLocked(opts, plan, locks, entitlement);
  } catch (e) {
    await releaseLocks(locks);
    throw e;
  }
}

function entitlementSource(opts: OpenMemorySessionOptions): SubscriptionSource | undefined {
  if (opts.entitlement !== undefined) return opts.entitlement;
  const port = opts.port as Partial<SubscriptionSource>;
  return typeof port.status === "function" ? (opts.port as unknown as SubscriptionSource) : undefined;
}

async function releaseLocks(l: HeldLocks): Promise<void> {
  for (const s of [...l.stateDirs].reverse()) await s.lock.release();
  await l.index.release();
}

function ownCellEventsAdvertised(entitlement: Entitlement): boolean {
  const events = parseServerFeatures(entitlement.status ?? {}).events;
  return events.kind === "available" && events.value.ownCellEvents;
}

function ownReadsPlan(opts: OpenMemorySessionOptions, entitlement: Entitlement): { readonly reader: OwnCellReader } | { readonly reason: string } {
  const cf = opts.changeFeed;
  if (cf === undefined || cf === false) return { reason: "no change feed: only a cell the feed announces is read by id" };
  if (cf.ownReads === false) return { reason: "opted out (changeFeed.ownReads: false)" };
  const port = opts.port;
  if (port.recallOwn === undefined) return { reason: "the port offers no read by id (recallOwn)" };
  if (cf.ownReads !== true && !ownCellEventsAdvertised(entitlement)) {
    return { reason: "own-cell events are not advertised: reads by id run only where the server advertises them" };
  }
  return { reader: { recallOwn: (cellId) => port.recallOwn!(cellId) } };
}

async function restoreIndexRows(ws: WarmStart, store: EncryptedIndexStore, space: { readonly modelId: string; readonly dim: number }, identity: string): Promise<WarmStartRestore> {
  let local: Awaited<ReturnType<EncryptedIndexStore["load"]>>;
  try {
    local = await store.load(space);
  } catch {
    return { outcome: "cold", reason: "the local index could not be read (its key): the build decides" };
  }
  if (local.state === "loaded") return { outcome: "skipped", reason: "a local index for this embedding space is present" };
  const r = await restoreOrCold(ws, { agentIdHash: identity });
  if (r.mode === "cold") return { outcome: "cold", reason: r.reason };
  const part = r.parts.get(INDEX_PART_NAME);
  if (part === undefined) return { outcome: "cold", reason: `the snapshot carries no ${INDEX_PART_NAME} part` };
  const d = decodeIndexPart(part, space);
  if (!d.ok) return { outcome: "cold", reason: `the snapshot's index part did not verify: ${d.reason}` };
  try {
    await store.save(d.rows, space);
  } catch {
    return { outcome: "cold", reason: "the restored rows could not be written to the local index" };
  }
  return { outcome: "restored", snapshotId: r.snapshotId, coversThrough: r.coversThrough, rows: d.rows.length };
}

function reconcileSubstrate(r: ReconcileOptions, port: SaihmReadPort): { readonly substrate: SaihmReadPort } | { readonly reason: string } {
  const substrate = r.substrate ?? (port instanceof FederatedReadPort ? undefined : port);
  if (substrate === undefined) return { reason: "the session's port is a federation (tagged ids, a union index) — pass reconcile.substrate: the raw substrate port" };
  if (substrate instanceof FederatedReadPort) return { reason: "reconcile.substrate is a FederatedReadPort — its ids are tagged and its index is a union, so neither speaks for the substrate; pass the raw substrate port" };
  return { substrate };
}

function planStateFiles(opts: OpenMemorySessionOptions): StateFilePlan {
  const tenantId = opts.tenantId ?? opts.store.tenantId;
  let feedCursor: string | undefined;
  if (opts.erasureFeed !== false) {
    const fo: ErasureFeedOptions = opts.erasureFeed ?? {};
    if (fo.path !== undefined || (opts.agentIdHash ?? opts.port.agentIdHash) !== undefined) {
      feedCursor = joinPath(fo.stateDir ?? opts.store.dir, `erasure-feed.cursor.${tenantId}.json`);
    }
  }
  let withheld: string | undefined;
  if (opts.reconcile !== undefined && opts.reconcile !== false && opts.reconcile.withheld === undefined && "substrate" in reconcileSubstrate(opts.reconcile, opts.port)) {
    withheld = joinPath(opts.reconcile.stateDir ?? opts.store.dir, `reconcile.withheld.${tenantId}.json`);
  }
  return { ...(feedCursor !== undefined ? { feedCursor } : {}), ...(withheld !== undefined ? { withheld } : {}) };
}

async function stateDirsOutside(plan: StateFilePlan, indexDir: string): Promise<{ readonly dir: string; readonly holds: StateFileRole[] }[]> {
  const out: { dir: string; holds: StateFileRole[] }[] = [];
  const roles: [StateFileRole, string | undefined][] = [["erasure-feed cursor", plan.feedCursor], ["withheld set", plan.withheld]];
  for (const [role, file] of roles) {
    if (file === undefined) continue;
    const dir = await canonicalLockDir(dirname(file));
    if (dir === indexDir) continue;
    const same = out.find((g) => g.dir === dir);
    if (same !== undefined) same.holds.push(role);
    else out.push({ dir, holds: [role] });
  }
  return out;
}

function planned(path: string | undefined, what: StateFileRole): string {
  if (path === undefined) throw new Error(`openMemorySession: internal — the lock plan does not cover the ${what} this wiring is about to write`);
  return path;
}

async function openMemorySessionLocked(opts: OpenMemorySessionOptions, plan: StateFilePlan, locks: HeldLocks | undefined, entitlement: Entitlement): Promise<MemorySession> {
  const tenantId = opts.tenantId ?? opts.store.tenantId;
  const raw = await opts.port.readIndex();
  const exclude = new Set<Namespace>(opts.excludeNamespaces ?? []);
  const entries =
    exclude.size === 0 ? raw : raw.filter((e) => !exclude.has(parseLabel(e.label).namespace));

  const warmOpts: { tenantId: string; rrf?: Partial<RrfConfig>; namespaceSeparator?: string } = { tenantId };
  if (opts.rrf !== undefined) warmOpts.rrf = opts.rrf;
  if (opts.port instanceof FederatedReadPort) warmOpts.namespaceSeparator = opts.port.separator;
  const warmStartIdentity = opts.agentIdHash ?? opts.port.agentIdHash;
  const warmStartPlan: { readonly identity: string; readonly restore: WarmStartRestore } | { readonly reason: string } =
    opts.warmStart === undefined
      ? { reason: "not requested — pass warmStart (a snapshot client) to restore and take snapshots" }
      : warmStartIdentity === undefined || !/^[0-9a-f]{64}$/.test(warmStartIdentity)
        ? { reason: "identity unknown — pass agentIdHash (or a port that carries it): a snapshot belongs to one identity" }
        : { identity: warmStartIdentity, restore: await restoreIndexRows(opts.warmStart, opts.store, { modelId: opts.embedder.modelId, dim: opts.embedder.dim }, warmStartIdentity) };
  const warm = await buildWarmIndex(entries, opts.embedder, opts.store, warmOpts);

  const source = new SaihmBodySource(opts.port, opts.bodyConfig ?? {});
  const ownPlan = ownReadsPlan(opts, entitlement);
  const byId = "reader" in ownPlan ? new OwnCellBodySource(source, ownPlan.reader) : undefined;
  const live: BodySource = byId ?? source;
  const tierLatency = opts.tierLatency;
  const record = (tier: Tier, ms: number): void => tierLatency?.record(tier, ms);
  const persistent = opts.bodyStore
    ? new PersistentBodySource(live, opts.bodyStore, tierLatency !== undefined ? { onServed: (step, ms) => record(step === "own" ? "warm" : "cold", ms) } : {})
    : undefined;
  const auditTrail = opts.audit;
  const bodies: CachingBodySource = new CachingBodySource(persistent ?? live, {
    ...DEFAULT_CACHE_CONFIG,
    ...(tierLatency !== undefined
      ? {
          onServed: (step: ServeStep, ms: number) => {
            if (step === "own") record("hot", ms);
            else if (persistent === undefined) record("cold", ms);
          },
        }
      : {}),
    ...(auditTrail !== undefined
      ? {
          onEvict: (cellId: string) => {
            const at = opts.bodyStore?.presenceSync(cellId) ?? "absent";
            auditTrail.recordPaging(
              {
                cellId,
                from: "hot",
                to: at === "present" ? "warm" : "cold",
                reason: at === "unknown" ? "RAM cache capacity (LRU); the at-rest copy could not be checked" : "RAM cache capacity (LRU)",
              },
              "applied",
            );
          },
        }
      : {}),
  });

  if (opts.bodyStore && persistent) {
    const live = new Set(entries.filter((e) => !e.forgotten).map((e) => e.cellId));
    let stored: string[] = [];
    try {
      stored = await opts.bodyStore.list();
    } catch {
      stored = [];
    }
    for (const id of stored) {
      if (live.has(id)) continue;
      try {
        await persistent.forget(id);
      } catch {
      }
    }
  }

  const bus = new ErasureBus();
  bus.subscribe((cellId) => warm.onErased(cellId));
  bus.subscribe(async (cellId) => {
    await bodies.forget(cellId);
    if (persistent) await persistent.forget(cellId);
    await source.forget(cellId);
    byId?.forget(cellId);
  });

  const detector = new ErasureDetector(opts.port, bus);
  detector.prime(entries);

  let answerRetriever: RankRetriever = warm.retriever;
  const labelOf = new Map(entries.filter((e) => !e.forgotten).map((e) => [e.cellId, e.label] as const));
  {
    bus.subscribe((cellId) => {
      labelOf.delete(cellId);
    });
  }

  let stampOf: StampLookup;
  if (opts.stampOf) {
    stampOf = opts.stampOf;
  } else {
    const stampMemo = new Map<string, LifecycleStamp>();
    bus.subscribe((cellId) => {
      stampMemo.delete(cellId);
    });
    stampOf = (id) => {
      const hit = stampMemo.get(id);
      if (hit !== undefined) return hit;
      const label = labelOf.get(id);
      const stamp = label === undefined ? {} : parseLifecycle(label);
      if (label !== undefined) stampMemo.set(id, stamp);
      return stamp;
    };
  }

  const stackDeps: LeverStackDeps = {
    base: answerRetriever,
    labelOf: (id) => labelOf.get(id),
    bodies,
    ...(opts.reranker !== undefined ? { reranker: opts.reranker } : {}),
    stampOf,
    ...(opts.onRerankFallback !== undefined ? { onRerankFallback: opts.onRerankFallback } : {}),
  };
  const stack = composeLeverStack(stackDeps, opts);
  answerRetriever = stack.retriever;
  const rerankRetriever = stack.rerankRetriever;
  const threadRetriever = stack.threadRetriever;

  let standingWiring: StandingWiring | undefined;
  if (opts.standingStore) {
    const standingLabelOf: LabelLookup = opts.standingLabelOf ?? ((id) => labelOf.get(id));
    const index = new ContentFingerprintIndex(
      standingLabelOf,
      opts.standingBodies ? { bodies: opts.standingBodies } : {},
    );
    const store = opts.standingStore;
    bus.subscribe(store.purge);
    bus.subscribe((cellId) => index.forget(cellId));
    standingWiring = { store, index, scope: opts.standingBodies ? "label+body" : "label" };
  }

  if (opts.derivedStore) {
    const ds = opts.derivedStore;
    const cascade = ds.cascade;
    if (cascade !== undefined) {
      bus.subscribe(async (cellId) => {
        const report = await cascade(cellId);
        if (report.forgotten.length > 0) await bus.publish(report.forgotten);
      });
    } else bus.subscribe(ds.onSourceErased);
  }
  if (opts.audit) bus.subscribe(opts.audit.erasureListener());
  const shared = opts.derivedLineage;
  if (shared?.forget) bus.subscribe((cellId) => shared.forget!(cellId));
  const own = opts.derivedStore;
  const lineageLookup = (cellId: string): readonly string[] | undefined =>
    own?.lineageOf?.(cellId) ?? shared?.lineageOf(cellId);
  if (own?.retirements) {
    const apply = () => warm.retriever.setRetirements(own.retirements!());
    apply();
    bus.subscribe(() => apply());
  }

  if (opts.onErased !== undefined) bus.subscribe(opts.onErased);
  let feed: FeedWatcher | undefined;
  let feedUnwired: ErasureFeedStatus | undefined;
  let feedPathWired: string | undefined;
  let follower: ChangeFeedFollower | undefined;
  let lastFeedPoint: { readonly ino: number; readonly offset: number } | undefined;
  if (opts.erasureFeed === false) {
    feedUnwired = { mode: "opted-out" };
  } else {
    const fo: ErasureFeedOptions = opts.erasureFeed ?? {};
    const identity = opts.agentIdHash ?? opts.port.agentIdHash;
    if (identity !== undefined && !/^[0-9a-f]{64}$/.test(identity)) throw new Error("openMemorySession: agentIdHash must be a 64-hex agentIdHash");
    let feedPath = fo.path;
    if (feedPath === undefined) {
      if (identity === undefined) {
        feedUnwired = { mode: "not-wired", reason: "identity unknown — pass agentIdHash (or a port that carries it; a FederatedReadPort forwards the one identity its sources agree on) so the per-identity feed can be located, or erasureFeed: false to opt out explicitly" };
      } else {
        feedPath = resolveFeedPath({ identity, env: fo.env ?? process.env, homeDir: fo.homeDir ?? homedir() });
      }
    }
    if (feedPath !== undefined) {
      const trail = auditTrail;
      const map = fo.mapCellId ?? ((id: string): readonly string[] => [id]);
      feedPathWired = feedPath;
      const sink: FeedSink = {
        consume: async (batch) => {
          const ids = [...new Set(batch.flatMap((b) => map(b.line.cellId)))];
          if (ids.length > 0) await bus.publish(ids);
          if (trail !== undefined) for (const b of batch) trail.recordFeed(b);
          if (follower !== undefined) for (const b of batch) follower.erased(b.line.cellId);
        },
        progressed: (point) => {
          lastFeedPoint = point;
          follower?.erasureProgress(point);
        },
        ...(trail !== undefined ? { fault: (f: FeedFault) => trail.recordFeedFault(f) } : {}),
      };
      feed = new FeedWatcher(
        {
          path: feedPath,
          ...(identity !== undefined ? { agentIdHash: identity } : {}),
          cursor: new FileFeedCursorStore(planned(plan.feedCursor, "erasure-feed cursor")),
          ...(fo.pollMs !== undefined ? { pollMs: fo.pollMs } : {}),
          ...(fo.onError !== undefined ? { onError: fo.onError } : {}),
          ...(fo.now !== undefined ? { now: fo.now } : {}),
          ...(fo.watch !== undefined ? { watch: fo.watch } : {}),
        },
        sink,
      );
      await feed.load();
      const consumedBefore = trail !== undefined ? await feed.consumedLines() : [];
      await feed.start();
      if (trail !== undefined) {
        const live = new Set(entries.filter((e) => !e.forgotten).map((e) => e.cellId));
        for (const l of consumedBefore) if (map(l.cellId).some((id) => live.has(id))) trail.recordFeedLive(l.cellId);
      }
    }
  }

  let reconcileCfg: ResolvedReconcile | undefined;
  let reconcileUnwired: ReconciliationStatus | undefined;
  if (opts.reconcile === false) {
    reconcileUnwired = { mode: "opted-out" };
  } else if (opts.reconcile === undefined) {
    reconcileUnwired = { mode: "not-wired", reason: "no candidates named — pass reconcile: { candidates, substrate } to reconcile copied rows against the substrate, or reconcile: false to opt out explicitly" };
  } else {
    const wiring = reconcileSubstrate(opts.reconcile, opts.port);
    if (!("substrate" in wiring)) {
      reconcileUnwired = { mode: "not-wired", reason: wiring.reason };
    } else {
      const substrate = wiring.substrate;
      const withheld = opts.reconcile.withheld ?? new FileWithheldStore(planned(plan.withheld, "withheld set"), { owner: locks?.index.dir ?? (await canonicalLockDir(opts.store.dir)) });
      reconcileCfg = {
        candidates: opts.reconcile.candidates, substrate, atOpen: opts.reconcile.atOpen ?? true, maxProbes: opts.reconcile.maxProbes ?? 25, recallCap: opts.reconcile.recallCap ?? 200,
        listing: opts.reconcile.listing ?? (substrate.listVersionsPage !== undefined && ownCellEventsAdvertised(entitlement)),
        withheld, persisted: !(withheld instanceof MemoryWithheldStore),
      };
    }
  }

  const session = MemorySession._create(
    warm.retriever, bodies, answerRetriever, bus, detector, warm, opts.port, persistent, opts.bodyStore,
    rerankRetriever, threadRetriever, standingWiring, labelOf, stampOf, lineageLookup, opts.embedder, opts.audit,
    feed, feedUnwired, reconcileCfg, reconcileUnwired,
  );
  session._attachWriterLocks(locks);
  session._attachOwnReads(byId, "reason" in ownPlan ? ownPlan.reason : "");
  session._attachWarmStart(opts.warmStart !== undefined && "identity" in warmStartPlan ? { client: opts.warmStart, ...warmStartPlan } : undefined, "reason" in warmStartPlan ? warmStartPlan.reason : "");

  const changeIdentity = opts.agentIdHash ?? opts.port.agentIdHash;
  if (opts.changeFeed === undefined || opts.changeFeed === false) {
    session._attachChangeFeed(undefined, { mode: "not-wired", reason: opts.changeFeed === false ? "opted out" : "not requested — pass changeFeed: {} to follow the identity's change feed" });
  } else if (changeIdentity === undefined || !/^[0-9a-f]{64}$/.test(changeIdentity)) {
    session._attachChangeFeed(undefined, { mode: "not-wired", reason: "identity unknown — pass agentIdHash (or a port that carries it) so the per-identity change feed can be located" });
  } else {
    const co = opts.changeFeed;
    const changesPath = co.path ?? resolveChangesPath({ identity: changeIdentity, env: co.env ?? process.env, homeDir: co.homeDir ?? homedir() });
    const map = (opts.erasureFeed !== false ? opts.erasureFeed?.mapCellId : undefined) ?? ((id: string): readonly string[] => [id]);
    follower = new ChangeFeedFollower(
      {
        path: changesPath,
        erasurePath: feedPathWired ?? joinPath(dirname(changesPath), "erasures.ndjson"),
        agentIdHash: changeIdentity,
        ...(co.pollMs !== undefined ? { pollMs: co.pollMs } : {}),
        ...(co.livenessMs !== undefined ? { livenessMs: co.livenessMs } : {}),
        ...(co.reconcileRetryMs !== undefined ? { reconcileRetryMs: co.reconcileRetryMs } : {}),
        ...(co.now !== undefined ? { now: co.now } : {}),
        ...(co.onError !== undefined ? { onError: co.onError } : {}),
        ...(co.timer !== undefined ? { timer: co.timer } : {}),
      },
      {
        invalidate: async (cellId, version) => {
          for (const id of map(cellId)) await session._dropCachedBody(id, version.seq);
        },
        ...(co.onChanged !== undefined ? { onChanged: co.onChanged } : {}),
        ...(reconcileCfg !== undefined ? { reconcileByListing: async () => (await session.reconcile()).method === "listing" } : {}),
      },
    );
    session._attachChangeFeed(follower, undefined);
    if (lastFeedPoint !== undefined) follower.erasureProgress(lastFeedPoint);
  }

  if (reconcileCfg !== undefined) {
    bus.subscribe(session._onWithheldErased);
    await session._loadWithheld();
    if (reconcileCfg.atOpen && follower === undefined) await session.reconcile();
  }
  if (follower !== undefined) {
    try {
      await follower.start();
    } catch (e) {
      await session.close();
      throw e;
    }
  }
  return session;
}
