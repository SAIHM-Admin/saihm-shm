import { withPool, type Scope, type SelectOpts } from "../retrieval/scope.js";
import type { RankRetriever } from "../answer/answer_layer.js";
import type { BodySource } from "../answer/types.js";

export interface InjectionBudget {
  readonly maxItems: number;
  readonly maxChars?: number;
  readonly maxTokens?: number;
}

export const DEFAULT_INJECTION_BUDGET: InjectionBudget = { maxItems: 5 };

import { estimateTokens, type TokenEstimate } from "./token_estimate.js";
export { estimateTokens, type TokenEstimate } from "./token_estimate.js";

export interface InjectedMemory {
  readonly cellId: string;
  readonly text: string;
  readonly rank: number;
  readonly epoch: number;
  readonly tier: string;
  readonly partial: boolean;
  readonly chars: number;
}

export interface InjectionDrop {
  readonly cellId: string;
  readonly rank: number;
  readonly reason: "below-floor" | "unavailable" | "char-budget" | "token-budget";
  readonly score?: number;
}

export interface InjectionResult {
  readonly cue: string;
  readonly injected: readonly InjectedMemory[];
  readonly budget: InjectionBudget;
  readonly usedChars: number;
  readonly usedTokens?: number;
  readonly dropped: readonly InjectionDrop[];
  readonly relevanceFloor?: number;
  readonly scope?: string;
}

export type CueDeriver = (taskContext: string) => string;

export const defaultCueDeriver: CueDeriver = (t) => t.replace(/\s+/g, " ").trim();

function nonNegIntElse(v: number | undefined, dflt: number): number {
  return Number.isFinite(v) && (v as number) >= 0 ? Math.floor(v as number) : dflt;
}

export class ProactiveInjector {
  private readonly deriveCue: CueDeriver;

  private readonly tokenEstimate: TokenEstimate;

  private readonly onResult: ((result: InjectionResult) => void) | undefined;

  constructor(
    private readonly retriever: RankRetriever,
    private readonly bodies: BodySource,
    private readonly cfg: {
      budget?: InjectionBudget;
      deriveCue?: CueDeriver;
      relevanceFloor?: number;
      tokenEstimate?: TokenEstimate;
      onResult?: (result: InjectionResult) => void;
    } = {},
  ) {
    this.deriveCue = cfg.deriveCue ?? defaultCueDeriver;
    this.tokenEstimate = cfg.tokenEstimate ?? estimateTokens;
    this.onResult = cfg.onResult;
  }

  async assemble(
    taskContext: string,
    budgetOverride?: InjectionBudget,
    asOfEpoch?: number,
    scope?: Scope,
  ): Promise<InjectionResult> {
    const result = await this.assembleCore(taskContext, budgetOverride, asOfEpoch, scope);
    if (this.onResult !== undefined) {
      try {
        this.onResult(result);
      } catch {
      }
    }
    return result;
  }

  private async assembleCore(
    taskContext: string,
    budgetOverride?: InjectionBudget,
    asOfEpoch?: number,
    scope?: Scope,
  ): Promise<InjectionResult> {
    const rawBudget = budgetOverride ?? this.cfg.budget ?? DEFAULT_INJECTION_BUDGET;
    const maxItems = nonNegIntElse(rawBudget.maxItems, DEFAULT_INJECTION_BUDGET.maxItems);
    const maxChars =
      Number.isFinite(rawBudget.maxChars) && (rawBudget.maxChars as number) >= 1
        ? Math.floor(rawBudget.maxChars as number)
        : undefined;
    const maxTokens =
      Number.isFinite(rawBudget.maxTokens) && (rawBudget.maxTokens as number) >= 1
        ? Math.floor(rawBudget.maxTokens as number)
        : undefined;
    const budget: InjectionBudget = {
      maxItems,
      ...(maxChars !== undefined ? { maxChars } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };

    const wantFloor = Number.isFinite(this.cfg.relevanceFloor) && typeof this.retriever.selectScored === "function";
    const floor = wantFloor ? (this.cfg.relevanceFloor as number) : undefined;

    const cue = this.deriveCue(taskContext);
    const dropped: InjectionDrop[] = [];
    if (cue === "" || maxItems === 0) {
      const base = { cue, injected: [], budget, usedChars: 0, dropped };
      return {
        ...base,
        ...(maxTokens !== undefined ? { usedTokens: 0 } : {}),
        ...(floor !== undefined ? { relevanceFloor: floor } : {}),
        ...(scope !== undefined ? { scope: scope.name } : {}),
      };
    }

    const selOpts: SelectOpts = withPool(
      {
        ...(asOfEpoch !== undefined ? { asOfEpoch } : {}),
        ...(scope !== undefined ? { scope } : {}),
      },
      maxItems,
    );
    const scoreOf = new Map<string, number>();
    let ranked: string[];
    if (floor !== undefined) {
      const scored = await this.retriever.selectScored!(cue, selOpts);
      ranked = scored.map((h) => h.cellId);
      for (const h of scored) if (!scoreOf.has(h.cellId)) scoreOf.set(h.cellId, h.score);
    } else {
      ranked = await this.retriever.select(cue, selOpts);
    }
    const seen = new Set<string>();
    const candidates: { id: string; rank: number }[] = [];
    for (const id of ranked) {
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push({ id, rank: candidates.length + 1 });
      if (candidates.length === maxItems) break;
    }

    const surviving = candidates.filter(({ id, rank }) => {
      if (floor === undefined) return true;
      const s = scoreOf.get(id);
      if (s !== undefined && s < floor) {
        dropped.push({ cellId: id, rank, reason: "below-floor", score: s });
        return false;
      }
      return true;
    });

    const fetched = await this.bodies.fetchByIds(surviving.map((c) => c.id), { query: cue });
    const byId = new Map(fetched.map((b) => [b.cellId, b]));

    const injected: InjectedMemory[] = [];
    let usedChars = 0;
    let usedTokens = 0;
    let charCapped = false;
    let tokenCapped = false;
    for (const { id, rank } of surviving) {
      const body = byId.get(id);
      if (!body) {
        dropped.push({ cellId: id, rank, reason: "unavailable" });
        continue;
      }
      const chars = body.plaintext.length;
      if (charCapped || (maxChars !== undefined && usedChars + chars > maxChars)) {
        charCapped = true;
        dropped.push({ cellId: id, rank, reason: "char-budget" });
        continue;
      }
      let tokens = 0;
      if (maxTokens !== undefined) {
        try {
          const t = this.tokenEstimate(body.plaintext);
          tokens = Number.isFinite(t) && t >= 0 ? t : Number.POSITIVE_INFINITY;
        } catch {
          tokens = Number.POSITIVE_INFINITY;
        }
        if (tokenCapped || usedTokens + tokens > maxTokens) {
          tokenCapped = true;
          dropped.push({ cellId: id, rank, reason: "token-budget" });
          continue;
        }
      }
      usedChars += chars;
      usedTokens += tokens;
      injected.push({
        cellId: id,
        text: body.plaintext,
        rank,
        epoch: body.epoch,
        tier: body.tier,
        partial: body.partial === true,
        chars,
      });
    }

    const result = { cue, injected, budget, usedChars, dropped };
    return {
      ...result,
      ...(maxTokens !== undefined ? { usedTokens } : {}),
      ...(floor !== undefined ? { relevanceFloor: floor } : {}),
      ...(scope !== undefined ? { scope: scope.name } : {}),
    };
  }
}
