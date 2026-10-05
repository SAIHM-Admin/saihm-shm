import { admitsSafely, type Scope } from "../retrieval/scope.js";

export interface EvidenceRef {
  readonly cellId: string;
  readonly fingerprint: string;
}

export interface StandingAnswer {
  readonly question: string;
  readonly answer: string;
  readonly evidence: readonly EvidenceRef[];
  readonly writtenAtEpoch: number;
}

export type FingerprintLookup = (cellId: string) => string | undefined;

export type StandingStatus = "fresh" | "stale" | "unauditable";

export interface StandingVerdict {
  readonly status: StandingStatus;
  readonly changed: readonly string[];
  readonly unresolved: readonly string[];
}

export function verifyStandingAnswer(
  answer: StandingAnswer,
  fingerprintOf: FingerprintLookup,
): StandingVerdict {
  if (answer.evidence.length === 0) {
    return { status: "unauditable", changed: [], unresolved: [] };
  }
  const changed: string[] = [];
  const unresolved: string[] = [];
  for (const ref of answer.evidence) {
    let current: string | undefined;
    try {
      current = fingerprintOf(ref.cellId);
    } catch {
      current = undefined;
    }
    if (current === undefined) unresolved.push(ref.cellId);
    else if (current !== ref.fingerprint) changed.push(ref.cellId);
  }
  const status: StandingStatus = changed.length + unresolved.length > 0 ? "stale" : "fresh";
  return { status, changed, unresolved };
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export class StandingAnswerStore {
  private answers: StandingAnswer[] = [];

  remember(answer: StandingAnswer): void {
    this.answers.push(answer);
  }

  purge(cellId: string): void {
    this.answers = this.answers.filter((a) => !a.evidence.some((e) => e.cellId === cellId));
  }

  get size(): number {
    return this.answers.length;
  }

  all(): readonly StandingAnswer[] {
    return this.answers;
  }
}

export interface StandingCandidate {
  readonly answer: StandingAnswer;
  readonly overlap: number;
  readonly verdict: StandingVerdict;
}

export interface StandingRecallConfig {
  readonly minOverlap?: number;
  readonly asOfEpoch?: number;
  readonly scope?: Scope;
  readonly maxCandidates?: number;
}

export const DEFAULT_STANDING = { minOverlap: 0.6, maxCandidates: 3 } as const;

export function recallStanding(
  retrievedCellIds: readonly string[],
  store: StandingAnswerStore,
  fingerprintOf: FingerprintLookup,
  cfg: StandingRecallConfig = {},
): readonly StandingCandidate[] {
  const minOverlap =
    Number.isFinite(cfg.minOverlap) && (cfg.minOverlap as number) >= 0
      ? (cfg.minOverlap as number)
      : DEFAULT_STANDING.minOverlap;
  const maxCandidates =
    Number.isFinite(cfg.maxCandidates) && (cfg.maxCandidates as number) >= 1
      ? Math.floor(cfg.maxCandidates as number)
      : DEFAULT_STANDING.maxCandidates;
  const asOf = Number.isFinite(cfg.asOfEpoch) ? (cfg.asOfEpoch as number) : undefined;

  const now = new Set(retrievedCellIds);
  const out: StandingCandidate[] = [];
  for (const answer of store.all()) {
    if (asOf !== undefined && answer.writtenAtEpoch > asOf) continue;
    if (cfg.scope !== undefined && !answer.evidence.every((e) => admitsSafely(cfg.scope, e.cellId))) continue;
    const overlap = jaccard(now, new Set(answer.evidence.map((e) => e.cellId)));
    if (overlap < minOverlap || overlap === 0) continue;
    out.push({ answer, overlap, verdict: verifyStandingAnswer(answer, fingerprintOf) });
  }
  return out.sort((a, b) => b.overlap - a.overlap || b.answer.writtenAtEpoch - a.answer.writtenAtEpoch)
    .slice(0, maxCandidates);
}
