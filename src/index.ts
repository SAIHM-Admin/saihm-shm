export { openMemorySession, MemorySession } from "./session/index.js";
export {
  PAID_SUBSCRIPTION_TIERS, isPaidSubscriptionTier, checkEntitlement, EntitlementError, DEFAULT_ENTITLEMENT_TIMEOUT_MS,
  type SubscriptionSource, type Entitlement, type EntitlementRefusal, type CheckEntitlementOptions,
} from "./entitlement/index.js";
export type {
  OpenMemorySessionOptions,
  WatchOptions,
  RerankStats,
  ThreadStats,
  StandingSessionStore,
} from "./session/index.js";

export {
  PRODUCTION_PROFILE,
  productionSessionOptions,
} from "./profile/index.js";
export type { ProductionProfile } from "./profile/index.js";
export {
  MarkdownDirPort,
  federatedStampOf,
  parseFrontmatter,
  stampFromDocument,
  describeDocument,
  deriveLabel,
  truncateCodePoints,
} from "./adapter/index.js";
export type {
  MarkdownDirPortOptions,
  MarkdownDirStats,
  ParsedDocument,
  DocumentDescription,
  StampSource,
  StampedSource,
} from "./adapter/index.js";

export { LocalMiniLmEmbedder, RemoteHttpEmbedder } from "./embed/index.js";
export type { Embedder, EmbedResult } from "./embed/index.js";

export { EncryptedIndexStore, EncryptedBodyStore } from "./store/index.js";
export { acquireWriterLock, StoreLockedError, WRITER_LOCK_FILENAME, pidIsAlive } from "./store/index.js";
export type { WriterLock, WriterLockHolder, WriterLockOptions, WriterLockRefusal } from "./store/index.js";
export { StateDirExposedError, inspectStateDir, stateDirExposure } from "./store/index.js";
export type { StateDirExposure } from "./store/index.js";
export { verifyWarmIndex } from "./store/index.js";
export type {
  WarmVerifyOpts,
  WarmVerifyStats,
  WarmVerifyMismatch,
} from "./store/index.js";

export { CrossEncoderReranker, IdentityReranker } from "./rerank/index.js";
export type { Reranker, RerankCandidate } from "./rerank/index.js";
export { DocumentAggregatingRetriever, DEFAULT_AGGREGATION, aggregateOrder } from "./aggregate/index.js";
export type { AggregationConfig, DocumentLookup } from "./aggregate/index.js";

export type {
  MatchProvenance,
  RankedHit,
  AdmittedRow,
  RrfConfig,
} from "./retrieval/semantic.js";

export { scopeFrom, composeScopes, admitsSafely, withPool, admissionOf, withLineage } from "./retrieval/scope.js";
export type { LineageLookups } from "./retrieval/scope.js";
export { retrievalText } from "./retrieval/label_text.js";
export {
  SaihmDerivedStore, InMemoryMintedLedger, FileMintedLedger, HeaderLineageIndex,
  encodeDerivedCell, parseDerivedCell, isDerivedLabel, labelOfDerived, DERIVED_MARKER,
  planConsolidation, ConsolidationCycle, renderRunReport,
} from "./derived/index.js";
export type { ConsolidationProposal, PlanInput, PlanOptions, Distilled, Distiller, RunOptions, RunReport, ConsolidationCycleOptions, TierPass, TierPassResult, TierPassReport } from "./derived/index.js";
export { validateStorePolicy, encodePolicyCell, parsePolicyCell, degradedPolicy, resolveStorePolicy, assertWriteAllowed, POLICY_MARKER } from "./policy/index.js";
export type { StorePolicy, StoreTier, PolicyAuthority, OnUnavailable, ResolvedPolicy, PolicySource } from "./policy/index.js";
export type {
  DerivedItem, DerivedHeader, DerivedKind, DerivedOwnership, MintedLedger, MintedRecord, DestructionAttestation,
  SaihmDerivedStoreOptions, CommitInput, CommitReceipt, CascadeReport, AttestationRetryReport,
} from "./derived/index.js";
export { STANDING_GUIDANCE_NAMESPACES } from "./ingest/index.js";
export type { Scope, SelectOpts, AdmissionOpts, ScopeSpec, ScopeLookups } from "./retrieval/scope.js";

export {
  PseudoRelevanceExpander,
  DEFAULT_QUERY_EXPANSION,
} from "./retrieval/query_expansion.js";
export type { QueryExpansionConfig } from "./retrieval/query_expansion.js";
export {
  LinkGraph,
  LinkExpansionRetriever,
  DEFAULT_LINK_EXPANSION,
} from "./retrieval/link_graph.js";
export type {
  LinkGraphStats,
  LinkExpansionConfig,
  LinksLookup,
  SlugLookup,
  CandidateGate,
} from "./retrieval/link_graph.js";

export {
  ThreadLifecycleRankRetriever,
  parseLifecycle,
  lifecycleDemote,
  threadJoin,
  DEFAULT_THREAD_LIFECYCLE,
  KNOWN_KINDS,
} from "./retrieval/thread_lifecycle.js";
export type {
  ThreadLifecycleConfig,
  ThreadLifecycleStats,
  ThreadLifecycleEffective,
  LifecycleStamp,
  StampLookup,
  ThreadStatus,
  DemoteMode,
} from "./retrieval/thread_lifecycle.js";

export {
  Consolidator,
  DEFAULT_CONSOLIDATION,
  BodyRedundancyIndex,
  shingleSet,
  jaccardOf,
  containmentOf,
  DEFAULT_SHINGLE_K,
  DEFAULT_BODY_REDUNDANCY,
  extractIndexTargets,
  stripIndexTargets,
  stripIndexLabels,
  assessIndexBudget,
  assessIndexBacking,
  guardIndex,
  DEFAULT_INDEX_GUARD,
} from "./consolidate/index.js";
export type {
  ConsolidationOp,
  ConsolidationConfig,
  ConsolidationDecision,
  RedundancyCluster,
  DensityStat,
  DensityBracket,
  BodyRedundancyConfig,
  BodyPair,
  BodyRedundancyStats,
  IndexLineInput,
  BackingVerdict,
  LineBacking,
  ProseBacking,
  BudgetLimits,
  BudgetAssessment,
  IndexGuardConfig,
  IndexGuardReport,
} from "./consolidate/index.js";

export { assembleBrief, DEFAULT_ASSEMBLY } from "./assemble/index.js";
export type {
  AssemblyConfig,
  AssembleOptions,
  Brief,
  BriefVerdict,
  BriefCell,
  BriefGroup,
  BriefConnector,
  ThreadGroup,
  ThreadView,
  ThreadLookup,
  AssemblyStats,
  Freshness,
  LabelLookup,
  FreshnessLookup,
} from "./assemble/index.js";
export { decidePosture } from "./assemble/index.js";
export type {
  PosturePin,
  PostureMemory,
  PostureReason,
  PostureDecision,
  PostureGateOptions,
} from "./assemble/index.js";

export {
  dereference,
  extractPointerTokens,
  splitSections,
  DEFAULT_DEREF,
  DEFAULT_POLICY,
  isContained,
  describePolicy,
  isDeniedName,
  resolveToken,
  resolveRoots,
  isRefusal,
  nodeFileSystem,
} from "./deref/index.js";
export type {
  Attachment,
  DerefCell,
  DerefConfig,
  DerefOptions,
  DerefResult,
  DerefStats,
  DerefVerdict,
  DerefRoot,
  FileSystemSeam,
  PolicyConfig,
  PolicyDescription,
  Refusal,
  RefusalReason,
  ResolvedFile,
  PreparedRoot,
  Section,
} from "./deref/index.js";

export { buildInjectionContext, countDataBoundaries } from "./answer/index.js";
export type { AnswerContext } from "./answer/index.js";

export { ProactiveInjector } from "./inject/index.js";
export type {
  InjectionBudget,
  InjectionResult,
  InjectedMemory,
} from "./inject/index.js";
export { selectNovel } from "./inject/index.js";
export type {
  InjectionCandidate,
  InjectionHistory,
  NoveltyDecision,
  SuppressedCandidate,
  SuppressionReason,
} from "./inject/index.js";
export { injectionWindowId } from "./inject/index.js";

export { classifyInjection, injectionFiringRate } from "./inject/index.js";
export type { InjectionStage, InjectionCounts, InjectionOutcome } from "./inject/index.js";
export type { InjectionWindowParts } from "./inject/index.js";

export type {
  SaihmReadPort,
  IndexEntry,
  RecalledBody,
  RecallOptions,
} from "./saihm_client/types.js";
export { FederatedReadPort } from "./saihm_client/federated_port.js";
export type {
  FederatedSource,
  FederatedReadPortOptions,
} from "./saihm_client/federated_port.js";

export {
  StandingAnswerStore,
  verifyStandingAnswer,
  recallStanding,
  jaccard,
  DEFAULT_STANDING,
  type StandingAnswer,
  type EvidenceRef,
  type FingerprintLookup,
  type StandingStatus,
  type StandingVerdict,
  type StandingCandidate,
  type StandingRecallConfig,
} from "./standing/standing_answers.js";

export {
  ContentFingerprintIndex,
  contentFingerprint,
  fingerprintScope,
  verifyStandingAnswerLive,
  recallStandingLive,
  type FingerprintScope,
  type FingerprintIndexConfig,
} from "./standing/content_fingerprint.js";

export {
  surfaceStanding,
  renderStanding,
  hasConclusion,
  NO_CONCLUSION,
  type StandingRecorder,
  type StandingSurfaceDeps,
  type StandingSurface,
} from "./standing/surface.js";

export { EncryptedStandingStore } from "./standing/standing_store.js";
export type {
  EncryptedStandingStoreConfig,
  StandingLoadResult,
} from "./standing/standing_store.js";

export {
  selectModes,
  validateRegistry,
  costOf,
  DEFAULT_MODES,
  type BehaviourMode,
  type ModeSelection,
  type ModeSelectOptions,
} from "./modes/behaviour_modes.js";

export {
  assessProvenance,
  findLiveStateClaims,
  newUnprovenanced,
  newUnprovenancedAgainst,
  unprovenancedBudget,
  normalizeProvenance,
  requireNoNewUnprovenanced,
  requireProvenance,
  UnprovenancedClaimError,
  DEFAULT_PROVENANCE,
  DEFAULT_CLAIM_KINDS,
  DEFAULT_PROVENANCE_MARKERS,
  type BudgetEntry,
  type ClaimKind,
  type KindTally,
  type LiveStateClaim,
  type ProvenanceConfig,
  type ProvenanceReport,
} from "./provenance/index.js";

export {
  HOT_SWAPPABLE_LEVERS,
  INDEX_TIME_LEVERS,
  LeverProfileError,
  isHotSwappable,
  normalizeLeverProfile,
  type HotSwappableLever,
  type LeverProfile,
  type NormalizeLeverOptions,
} from "./profile/index.js";

export { splitHoldout } from "./tuning/index.js";
export type { Holdout, HoldoutOptions, StratumBalance } from "./tuning/index.js";

export { gateScope, renderGateVerdict, requireConclusive } from "./gate/index.js";
export type { GateScope, GateScopeInput, VerdictLabels } from "./gate/index.js";

export { bindSymmetric, probeAsymmetry, probeRoundTrip } from "./gate/index.js";

export { verifyResume, requireSafeResume } from "./resume/index.js";
export type { ResumeClaim, ResumeReport, VerifiedClaim, ClaimVerdict, Probe, VerifyOptions } from "./resume/index.js";

export { obligationsOf, assessEdit, attentionQueue, THIN_COVERAGE } from "./attention/index.js";
export type {
  Obligation, ObligationKind, Reflow, EditReport,
  AttentionItem, AttentionInput, AttentionReport, AttentionSeverity,
} from "./attention/index.js";
export type {
  SymmetricGuard,
  SiftResult,
  AsymmetryProbe,
  AsymmetryReport,
  RoundTripProbe,
  RoundTripMutation,
  RoundTripReport,
} from "./gate/index.js";

export { sampleBias, stratifiedSample } from "./tuning/index.js";
export type { SampleBias, SampleResult, StratumDeviation } from "./tuning/index.js";

export { pairedCompare } from "./tuning/index.js";
export type { PairedComparison } from "./tuning/index.js";

export { composeLeverStack, DEFAULT_RERANK_BODY_WINDOW } from "./tuning/index.js";
export type { BodyWindowSource, LeverStack, LeverStackDeps } from "./tuning/index.js";

export { checkNumbers, renderDrift, fingerprintSources, sourceFilesUnder, compareBuild } from "./provenance/index.js";
export type { NumberClaim, NumberVerdict, DriftReport, BuildMismatch } from "./provenance/index.js";

export { ResidentSession, ServiceHandlers, ServiceError, serveHttp, renderInjectionText, LatencyRecorder, evaluateServiceLevel, evaluateTierLevel, SERVICE_TIERS } from "./service/index.js";
export type { ResidentConfig, ResidentHealth, ServiceOptions, ServiceHealth, RecallRequest, RecallResponse, RecallHit, PreactRequest, PreactResponse, ThreadsResponse, HttpServiceOptions, HttpService, ServiceLevel, LatencyStats, ServiceLevelVerdict, TierLevelVerdict } from "./service/index.js";

export { HostHookAdapter, runHostHook, TranscriptCompactionCounter, parseHostEvent, forwardableEvent, sanitizeHostReply, serializeHostReply, hostReply, sessionsUnder, ALL_SESSIONS } from "./host/index.js";
export type { HostHookAdapterOptions, HostTurnRecord, HostRankedMemory, HostTurnOutcome, HostChannel, HostEvent, HostEventName, HostHookReply, HostHookClientOptions, HostHookClientOutcome, HostHookTarget, TranscriptCompactionOptions, CompactCountOf, SessionAdmission } from "./host/index.js";

export { assembleHistory, epochsFromHits, renderHistoryReport } from "./history/index.js";
export type { HistoryHit, HistoryView, HistoryChange, HistoryReport, HistoryVerdict, ViewReason, KnowableAt, AssembleHistoryInput } from "./history/index.js";
export type { HistoryOptions } from "./session/index.js";

export { assembleFleetReport, renderFleetReport, LARGEST_CLUSTERS } from "./fleet/index.js";
export type { FleetRow, FleetPolicy, FleetFlag, FleetPartition, ClusterSummary, FleetConcentration, FleetVerdict, FleetReport, FleetInput } from "./fleet/index.js";
export type { FleetOptions } from "./session/index.js";

export { AuditTrail, DEFAULT_MAX_EVENTS, assembleComplianceReport, renderComplianceReport } from "./compliance/index.js";
export type { AuditEvent, AuditKind, AuditTrailOptions, ComplianceOptions, ComplianceReport, ComplianceSection, SectionStatus } from "./compliance/index.js";

export { FeedWatcher, FileFeedCursorStore, MemoryFeedCursorStore, parseFeedLine, resolveFeedPath, splitCompleteLines, FEED_FILENAME, FEED_MAX_LINE_BYTES, FEED_VERSION, DEFAULT_FEED_POLL_MS } from "./erasure/index.js";
export type { FeedLine, FeedLineVerdict, FeedFaultOutcome, FeedCursor, FeedCursorStore, FeedConsumed, FeedFault, FeedSink, FeedWatcherConfig, FeedWatcherStatus, ResolveFeedPathInput } from "./erasure/index.js";

export { TIER_RANK, validateTierPolicy, tierOf, planTiers, renderTierPlan } from "./tiers/index.js";
export type { Tier, TierPolicy, TierSignals, TierDecision, TierState, PagingAction, TierPlan } from "./tiers/index.js";
export type { TierOptions, PagingOutcome } from "./session/index.js";
export { decideFromIndex, decideFromProbe, summarize } from "./erasure/index.js";
export type { ReconcileCandidate, ReconcileDecision, ReconcileSummary, ReconcileVerdict, ReconcileEvidence, ProbeResult } from "./erasure/index.js";
export type { ReconcileOptions, ReconciliationStatus, ReleaseOutcome, WriterLockStatus } from "./session/index.js";
export { FileWithheldStore, MemoryWithheldStore, WithheldStoreCorruptError, WITHHELD_FILE_VERSION } from "./erasure/index.js";
export type { WithheldStore } from "./erasure/index.js";
export type { QueryVector } from "./retrieval/semantic.js";
