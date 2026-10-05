export type InjectionStage = "retrieval" | "novelty" | "budget" | "quarantine" | "rendered";

export interface InjectionCounts {
  readonly cleared: number;
  readonly novel: number;
  readonly shown: number;
  readonly quarantineEmpty: boolean;
}

export interface InjectionOutcome extends InjectionCounts {
  readonly fired: boolean;
  readonly stage: InjectionStage;
  readonly capped: number;
}

export function classifyInjection(c: InjectionCounts): InjectionOutcome {
  if (!Number.isInteger(c.cleared) || !Number.isInteger(c.novel) || !Number.isInteger(c.shown)) {
    throw new Error(`injection counts must be integers (got ${c.cleared}/${c.novel}/${c.shown})`);
  }
  if (c.cleared < 0 || c.novel < 0 || c.shown < 0) {
    throw new Error(`injection counts must be non-negative (got ${c.cleared}/${c.novel}/${c.shown})`);
  }
  if (c.novel > c.cleared || c.shown > c.novel) {
    throw new Error(
      `non-monotone injection funnel: shown ${c.shown} <= novel ${c.novel} <= cleared ${c.cleared} is violated`,
    );
  }
  const capped = c.novel - c.shown;
  const stage: InjectionStage =
    c.cleared === 0 ? "retrieval"
    : c.novel === 0 ? "novelty"
    : c.shown === 0 ? "budget"
    : c.quarantineEmpty ? "quarantine"
    : "rendered";
  return { ...c, capped, fired: stage === "rendered", stage };
}

export function injectionFiringRate(outcomes: readonly InjectionOutcome[]): {
  readonly n: number;
  readonly fired: number;
  readonly rate: number;
  readonly byStage: Readonly<Record<InjectionStage, number>>;
} {
  const byStage: Record<InjectionStage, number> =
    { retrieval: 0, novelty: 0, budget: 0, quarantine: 0, rendered: 0 };
  for (const o of outcomes) byStage[o.stage] += 1;
  const fired = byStage.rendered;
  return { n: outcomes.length, fired, rate: outcomes.length === 0 ? NaN : fired / outcomes.length, byStage };
}
