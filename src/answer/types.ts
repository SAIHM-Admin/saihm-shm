import type { RecalledBody } from "../saihm_client/types.js";

export interface AnswerContext {
  readonly prompt: string;
  readonly cellIds: readonly string[];
  readonly blockCount: number;
  readonly neutralized: boolean;
  readonly nonce: string;
}

export interface AnswerRequest {
  readonly question: string;
  readonly context: AnswerContext;
}

export interface RawAnswer {
  readonly text: string;
  readonly abstained: boolean;
  readonly confidence: number;
  readonly citedCellIds: readonly string[];
}

export interface Answerer {
  readonly modelId: string;
  answer(req: AnswerRequest): Promise<RawAnswer>;
}

export interface BodySource {
  fetchByIds(cellIds: readonly string[], hint?: BodyFetchHint): Promise<RecalledBody[]>;
}

export interface ErasableBodySource extends BodySource {
  forget(cellId: string): void | Promise<void>;
}

export type ServeStep = "own" | "inner";

export interface BodyFetchHint {
  readonly query?: string;
}

export interface AbstentionConfig {
  readonly minConfidence: number;
  readonly requireCitation: boolean;
}

export const DEFAULT_ABSTENTION: AbstentionConfig = { minConfidence: 0.5, requireCitation: true };

export interface GroundingBudgetAudit {
  readonly usedTokens: number;
  readonly droppedForBudget: readonly string[];
}

export type GroundedAnswer =
  | {
      readonly answered: true;
      readonly text: string;
      readonly citations: readonly string[];
      readonly droppedCitations: readonly string[];
      readonly budget?: GroundingBudgetAudit;
    }
  | {
      readonly answered: false;
      readonly reason:
        | "answerer-abstained"
        | "below-confidence-threshold"
        | "ungrounded"
        | "malformed-answer";
      readonly budget?: GroundingBudgetAudit;
    };
