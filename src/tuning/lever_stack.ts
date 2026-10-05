import type { RankRetriever } from "../answer/answer_layer.js";
import { PseudoRelevanceExpander } from "../retrieval/query_expansion.js";
import { RerankingRankRetriever, type PoolTextSource } from "../rerank/reranking_select.js";
import type { Reranker } from "../rerank/types.js";
import {
  ThreadLifecycleRankRetriever,
  assertThreadPoolWithinRerank,
  type DemoteMode,
  type StampLookup,
} from "../retrieval/thread_lifecycle.js";
import type { LeverProfile } from "../profile/lever_profile.js";
import { SessionClosedError } from "../retrieval/session_closed.js";

export const DEFAULT_RERANK_BODY_WINDOW = 256;

export interface BodyWindowSource {
  fetchByIds(ids: readonly string[]): Promise<readonly { cellId: string; plaintext: string }[]>;
}

export interface LeverStackDeps {
  readonly base: RankRetriever;
  readonly labelOf: (cellId: string) => string | undefined;
  readonly bodies?: BodyWindowSource;
  readonly reranker?: Reranker;
  readonly stampOf?: StampLookup;
  readonly onRerankFallback?: (err: unknown) => void;
}

export interface LeverStack {
  readonly retriever: RankRetriever;
  readonly rerankRetriever: RerankingRankRetriever | undefined;
  readonly threadRetriever: ThreadLifecycleRankRetriever | undefined;
}

export function composeLeverStack(deps: LeverStackDeps, profile: LeverProfile): LeverStack {
  let retriever: RankRetriever = deps.base;

  if (profile.queryExpansion) {
    const qe: { prfN?: number; prfM?: number } = {};
    if (profile.queryExpansionN !== undefined) qe.prfN = profile.queryExpansionN;
    if (profile.queryExpansionM !== undefined) qe.prfM = profile.queryExpansionM;
    retriever = new PseudoRelevanceExpander(retriever, deps.labelOf, qe);
  }

  let rerankRetriever: RerankingRankRetriever | undefined;
  if (deps.reranker) {
    const rr: { rerankK?: number; textOf?: PoolTextSource; onFallback?: (err: unknown) => void } = {};
    if (profile.rerankK !== undefined) rr.rerankK = profile.rerankK;
    if (deps.onRerankFallback !== undefined) rr.onFallback = deps.onRerankFallback;
    if (profile.rerankOnBody && !deps.bodies) {
      throw new Error(
        `composeLeverStack: rerankOnBody is on but no bodies source was supplied. Degrading to label ` +
          `rerank here would silently serve a DIFFERENT lever than the one asked for — the same ` +
          `silent-no-op this module refuses for threadLifecycle. (A body FETCH that fails at query ` +
          `time still degrades to label rerank on purpose; that is resilience, this is a config error.)`,
      );
    }
    if (profile.rerankOnBody && deps.bodies) {
      const win =
        Number.isFinite(profile.rerankBodyWindowChars) && (profile.rerankBodyWindowChars as number) >= 1
          ? Math.floor(profile.rerankBodyWindowChars as number)
          : DEFAULT_RERANK_BODY_WINDOW;
      const bodies = deps.bodies;
      rr.textOf = async (ids) => {
        const m = new Map<string, string>();
        try {
          for (const b of await bodies.fetchByIds(ids)) m.set(b.cellId, b.plaintext.slice(0, win));
        } catch (err) {
          if (err instanceof SessionClosedError) throw err;
        }
        return m;
      };
    }
    rerankRetriever = new RerankingRankRetriever(retriever, deps.reranker, deps.labelOf, rr);
    retriever = rerankRetriever;
  }

  let threadRetriever: ThreadLifecycleRankRetriever | undefined;
  if (profile.threadLifecycle) {
    if (!deps.stampOf) {
      throw new Error(
        `composeLeverStack: threadLifecycle is on but no stampOf was supplied. Without a stamp source ` +
          `every cell is unstamped, so the lever would be a silent no-op rather than an error.`,
      );
    }
    assertThreadPoolWithinRerank({
      rerankK: profile.rerankK,
      threadPoolK: profile.threadPoolK,
      hasReranker: deps.reranker !== undefined,
      allowWider: profile.allowThreadPoolWiderThanRerank,
    });
    const tc: { poolK?: number; maxThreadGroup?: number; join?: boolean; demote?: DemoteMode } = {};
    if (profile.threadPoolK !== undefined) tc.poolK = profile.threadPoolK;
    if (profile.threadMaxGroup !== undefined) tc.maxThreadGroup = profile.threadMaxGroup;
    if (profile.threadJoin !== undefined) tc.join = profile.threadJoin;
    if (profile.threadDemote !== undefined) tc.demote = profile.threadDemote;
    threadRetriever = new ThreadLifecycleRankRetriever(retriever, deps.stampOf, tc);
    retriever = threadRetriever;
  }

  return { retriever, rerankRetriever, threadRetriever };
}
