import { shingleSet } from "./body_redundancy.js";

export interface IndexLineInput {
  readonly text: string;
  readonly targets: readonly string[];
}

export type BackingVerdict =
  | "scored"
  | "drift"
  | "unverifiable";

export interface ProseBacking {
  readonly own: number;
  readonly baseline: number;
  readonly baselineSe: number;
  readonly lift: number;
  readonly verdict: "scored" | "drift";
}

export interface LineBacking {
  readonly line: number;
  readonly text: string;
  readonly bytes: number;
  readonly targets: readonly string[];
  readonly missingTargets: readonly string[];
  readonly own: number;
  readonly baseline: number;
  readonly baselineSe: number;
  readonly lift: number;
  readonly adjusted: number;
  readonly verdict: BackingVerdict;
  readonly prose?: ProseBacking;
  readonly reason: string;
}

export interface BudgetLimits {
  readonly budgetBytes: number;
  readonly lossBytes: number;
}

export interface BudgetAssessment {
  readonly bytes: number;
  readonly budgetBytes: number;
  readonly lossBytes: number;
  readonly overBudget: boolean;
  readonly truncating: boolean;
  readonly headroomBytes: number;
  readonly lostLines: readonly number[];
  readonly partialLine: number;
}

export interface IndexGuardConfig {
  readonly shingleK: number;
  readonly baselineReps: number;
  readonly driftLift: number;
}

export const DEFAULT_INDEX_GUARD: IndexGuardConfig = {
  shingleK: 1,
  baselineReps: 100,
  driftLift: 0,
};

export interface IndexGuardReport {
  readonly budget: BudgetAssessment;
  readonly lines: readonly LineBacking[];
  readonly medianLift: number;
  readonly medianAdjusted: number;
  readonly verifiable: number;
  readonly unverifiable: number;
  readonly dangling: number;
}

const MD_LINK = /\]\(([A-Za-z0-9_-]+)\.md\)/g;
const WIKI_LINK = /\[\[([A-Za-z0-9_-]+)\]\]/g;
const LABELLED_LINK = /\[[^\[\]]*\]\(([A-Za-z0-9_-]+)\.md\)/g;

export function extractIndexTargets(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of [MD_LINK, WIKI_LINK]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const id = m[1]!;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

export function stripIndexTargets(text: string): string {
  return text.replace(MD_LINK, "]").replace(WIKI_LINK, " ");
}

export function stripIndexLabels(text: string): string {
  return text.replace(LABELLED_LINK, " ");
}

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

export function assessIndexBudget(
  lines: readonly IndexLineInput[],
  limits: BudgetLimits,
): BudgetAssessment {
  const { budgetBytes, lossBytes } = limits;
  if (!(budgetBytes > 0) || !(lossBytes > 0)) {
    throw new Error(`assessIndexBudget: byte limits must be positive, got ${budgetBytes}/${lossBytes}`);
  }
  if (lossBytes < budgetBytes) {
    throw new Error(
      `assessIndexBudget: lossBytes ${lossBytes} < budgetBytes ${budgetBytes} - a working budget above the loss threshold can never warn in time`,
    );
  }
  const lost: number[] = [];
  let partial = -1;
  let cursor = 0;
  for (const [i, l] of lines.entries()) {
    const start = cursor;
    cursor += byteLen(l.text) + 1;
    if (start >= lossBytes) lost.push(i);
    else if (cursor > lossBytes) partial = i;
  }
  return {
    bytes: cursor,
    budgetBytes,
    lossBytes,
    overBudget: cursor > budgetBytes,
    truncating: cursor > lossBytes,
    headroomBytes: budgetBytes - cursor,
    lostLines: lost,
    partialLine: partial,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleDistinct(pool: readonly string[], n: number, rnd: () => number): string[] {
  const idx = pool.map((_, i) => i);
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rnd() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(0, take).map((i) => pool[i]!);
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function meanAndSe(draws: readonly number[]): { mean: number; se: number } {
  const mean = draws.reduce((a, d) => a + d, 0) / draws.length;
  const se = draws.length < 2 ? NaN : Math.sqrt(draws.reduce((a, d) => a + (d - mean) ** 2, 0) / (draws.length - 1) / draws.length);
  return { mean, se };
}

export function assessIndexBacking(
  lines: readonly IndexLineInput[],
  bodyOf: (id: string) => string | undefined,
  corpusIds: readonly string[],
  config: Partial<IndexGuardConfig> = {},
): LineBacking[] {
  const cfg = { ...DEFAULT_INDEX_GUARD, ...config };
  if (!Number.isInteger(cfg.shingleK) || cfg.shingleK < 1) {
    throw new Error(`assessIndexBacking: shingleK must be a positive integer, got ${cfg.shingleK}`);
  }
  if (!Number.isInteger(cfg.baselineReps) || cfg.baselineReps < 1) {
    throw new Error(`assessIndexBacking: baselineReps must be a positive integer, got ${cfg.baselineReps}`);
  }
  const sets = new Map<string, ReadonlySet<string>>();
  const setOf = (id: string): ReadonlySet<string> => {
    let s = sets.get(id);
    if (s === undefined) {
      s = shingleSet(bodyOf(id)!, cfg.shingleK);
      sets.set(id, s);
    }
    return s;
  };
  const containedIn = (line: ReadonlySet<string>, ids: readonly string[]): number => {
    if (line.size === 0) return 0;
    const group = ids.map(setOf);
    let held = 0;
    for (const sh of line) if (group.some((g) => g.has(sh))) held += 1;
    return held / line.size;
  };
  const out: LineBacking[] = [];
  for (const [i, l] of lines.entries()) {
    const bytes = byteLen(l.text);
    const resolved: string[] = [];
    const missing: string[] = [];
    for (const t of l.targets) (bodyOf(t) === undefined ? missing : resolved).push(t);

    const bail = (reason: string): void => {
      out.push({
        line: i,
        text: l.text,
        bytes,
        targets: l.targets,
        missingTargets: missing,
        own: NaN,
        baseline: NaN,
        baselineSe: NaN,
        lift: NaN,
        adjusted: NaN,
        verdict: "unverifiable",
        reason,
      });
    };
    if (resolved.length === 0) {
      bail(l.targets.length === 0 ? "no targets" : `all ${missing.length} target(s) missing from the corpus`);
      continue;
    }
    const pool = [...new Set(corpusIds)].filter((id) => !resolved.includes(id) && bodyOf(id) !== undefined);
    if (pool.length < resolved.length) {
      bail(`control pool ${pool.length} < ${resolved.length} targets - no size-matched baseline`);
      continue;
    }
    const lineSet = shingleSet(stripIndexTargets(l.text), cfg.shingleK);
    if (lineSet.size === 0) {
      bail("nothing to measure: no word outside the pointer machinery (the measure reads ASCII letters and digits only)");
      continue;
    }
    const own = containedIn(lineSet, resolved);
    const unlabelled = stripIndexLabels(l.text);
    const proseSet = unlabelled === l.text ? undefined : shingleSet(stripIndexTargets(unlabelled), cfg.shingleK);
    const measureProse = proseSet !== undefined && proseSet.size > 0;

    const rnd = mulberry32(i * 2654435761 + resolved.length);
    const draws: number[] = [];
    const proseDraws: number[] = [];
    for (let rep = 0; rep < cfg.baselineReps; rep++) {
      const ids = sampleDistinct(pool, resolved.length, rnd);
      draws.push(containedIn(lineSet, ids));
      if (measureProse) proseDraws.push(containedIn(proseSet, ids));
    }
    const { mean: baseline, se: baselineSe } = meanAndSe(draws);
    const lift = own - baseline;
    let prose: ProseBacking | undefined;
    if (measureProse) {
      const pOwn = containedIn(proseSet, resolved);
      const p = meanAndSe(proseDraws);
      prose = { own: pOwn, baseline: p.mean, baselineSe: p.se, lift: pOwn - p.mean, verdict: pOwn - p.mean <= cfg.driftLift ? "drift" : "scored" };
    }
    const headroom = 1 - baseline;
    const adjusted = headroom > 0 ? lift / headroom : 0;
    out.push({
      line: i,
      text: l.text,
      bytes,
      targets: l.targets,
      missingTargets: missing,
      own,
      baseline,
      baselineSe,
      lift,
      adjusted,
      verdict: lift <= cfg.driftLift ? "drift" : "scored",
      reason: "",
      ...(prose !== undefined ? { prose } : {}),
    });
  }
  return out;
}

export function guardIndex(
  lines: readonly IndexLineInput[],
  bodyOf: (id: string) => string | undefined,
  corpusIds: readonly string[],
  limits: BudgetLimits,
  config: Partial<IndexGuardConfig> = {},
): IndexGuardReport {
  const budget = assessIndexBudget(lines, limits);
  const backing = assessIndexBacking(lines, bodyOf, corpusIds, config);
  const scored = backing.filter((b) => b.verdict !== "unverifiable");
  return {
    budget,
    lines: backing,
    medianLift: median(scored.map((b) => b.lift)),
    medianAdjusted: median(scored.map((b) => b.adjusted)),
    verifiable: scored.length,
    unverifiable: backing.length - scored.length,
    dangling: backing.filter((b) => b.missingTargets.length > 0).length,
  };
}
