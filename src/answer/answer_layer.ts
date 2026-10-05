import type { Scope, SelectOpts } from "../retrieval/scope.js";
import type { AbstentionConfig, Answerer, BodySource, GroundedAnswer, GroundingBudgetAudit } from "./types.js";
import { estimateTokens, type TokenEstimate } from "../inject/token_estimate.js";
import type { RecalledBody } from "../saihm_client/types.js";
import { DEFAULT_ABSTENTION } from "./types.js";
import { buildContext } from "./context.js";
import { decideAbstention } from "./gate.js";
import type { RankedHit } from "../retrieval/semantic.js";

export interface ScoredHit {
  readonly cellId: string;
  readonly score: number;
}

export interface RankRetriever {
  select(query: string, opts?: SelectOpts): Promise<string[]>;
  selectScored?(query: string, opts?: SelectOpts): Promise<readonly ScoredHit[]>;
  selectDetailed?(query: string, opts?: SelectOpts): Promise<readonly RankedHit[]>;
}

export interface AnswerLayerConfig {
  readonly topK: number;
  readonly abstention: AbstentionConfig;
  readonly maxTokens?: number;
  readonly tokenEstimate?: TokenEstimate;
}

export const DEFAULT_ANSWER_CONFIG: AnswerLayerConfig = { topK: 10, abstention: DEFAULT_ABSTENTION };

export class AnswerLayer {
  constructor(
    private readonly retriever: RankRetriever,
    private readonly bodies: BodySource,
    private readonly answerer: Answerer,
    private readonly cfg: AnswerLayerConfig = DEFAULT_ANSWER_CONFIG,
  ) {}

  async ask(question: string, opts?: { asOfEpoch?: number; scope?: Scope }): Promise<GroundedAnswer> {
    const selOpts: SelectOpts = {
      maxK: this.cfg.topK,
      ...(opts?.asOfEpoch !== undefined ? { asOfEpoch: opts.asOfEpoch } : {}),
      ...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
    };
    const ranked = await this.retriever.select(question, selOpts);
    const seen = new Set<string>();
    const topIds: string[] = [];
    for (const id of ranked) {
      if (seen.has(id)) continue;
      seen.add(id);
      topIds.push(id);
      if (topIds.length === this.cfg.topK) break;
    }
    const fetched = await this.bodies.fetchByIds(topIds, { query: question });
    const byId = new Map(fetched.map((b) => [b.cellId, b]));
    const ordered = topIds.map((id) => byId.get(id)).filter((b): b is NonNullable<typeof b> => !!b);

    const capped = this.applyTokenCap(ordered);
    const ctx = buildContext(question, capped.bodies);
    const raw = await this.answerer.answer({ question, context: ctx });
    const decided = decideAbstention(raw, ctx.cellIds, this.cfg.abstention);
    return capped.audit === undefined ? decided : { ...decided, budget: capped.audit };
  }

  private applyTokenCap(ordered: readonly RecalledBody[]): { bodies: readonly RecalledBody[]; audit?: GroundingBudgetAudit } {
    const cap = this.cfg.maxTokens;
    if (cap === undefined || !Number.isFinite(cap) || cap < 0) return { bodies: ordered };
    const count = this.cfg.tokenEstimate ?? estimateTokens;
    const kept: RecalledBody[] = [];
    const dropped: string[] = [];
    let used = 0;
    let cut = false;
    for (const b of ordered) {
      if (cut) {
        dropped.push(b.cellId);
        continue;
      }
      let t: number;
      try {
        t = count(b.plaintext);
      } catch {
        t = Number.NaN;
      }
      if (!Number.isFinite(t) || t < 0 || used + t > cap) {
        cut = true;
        dropped.push(b.cellId);
        continue;
      }
      used += t;
      kept.push(b);
    }
    return { bodies: kept, audit: { usedTokens: used, droppedForBudget: dropped } };
  }
}
