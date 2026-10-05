import type { ContentFingerprintIndex } from "./content_fingerprint.js";
import { recallStandingLive } from "./content_fingerprint.js";
import type {
  EvidenceRef,
  StandingAnswer,
  StandingAnswerStore,
  StandingCandidate,
  StandingRecallConfig,
} from "./standing_answers.js";

export const NO_CONCLUSION = "(no conclusion recorded — evidence set only)";

export function hasConclusion(answer: StandingAnswer): boolean {
  const t = answer.answer.trim();
  return t.length > 0 && t !== NO_CONCLUSION;
}

export interface StandingRecorder {
  snapshot(): StandingAnswerStore;
  record(answer: StandingAnswer): Promise<number> | number;
  load?(): Promise<unknown>;
}

export interface StandingSurfaceDeps {
  readonly store: StandingRecorder;
  readonly index: ContentFingerprintIndex;
}

export interface StandingSurface {
  readonly candidates: readonly StandingCandidate[];
  readonly handle?: number;
}

function sameEvidence(answer: StandingAnswer, ids: ReadonlySet<string>): boolean {
  const cited = new Set(answer.evidence.map((e) => e.cellId));
  if (cited.size !== ids.size) return false;
  for (const id of cited) if (!ids.has(id)) return false;
  return true;
}

export async function surfaceStanding(
  question: string,
  retrievedCellIds: readonly string[],
  deps: StandingSurfaceDeps,
  nowEpochMs: number,
  cfg: StandingRecallConfig = {},
): Promise<StandingSurface> {
  const ids = [...new Set(retrievedCellIds)];
  if (ids.length === 0) return { candidates: [] };
  if (deps.store.load) await deps.store.load();

  const snapshot = deps.store.snapshot();
  const candidates = await recallStandingLive(ids, snapshot, deps.index, cfg);

  const idSet = new Set(ids);
  const held = snapshot.all().some((a) => a.question === question && sameEvidence(a, idSet));
  if (held) return { candidates };

  const covered = new Set(candidates.flatMap((c) => c.answer.evidence.map((e) => e.cellId)));
  const need = ids.filter((id) => !covered.has(id));
  if (need.length > 0) await deps.index.refresh(need);

  const evidence: EvidenceRef[] = [];
  for (const cellId of ids) {
    const fingerprint = deps.index.lookup(cellId);
    if (fingerprint !== undefined) evidence.push({ cellId, fingerprint });
  }
  if (evidence.length === 0) return { candidates };

  const handle = await deps.store.record({
    question,
    answer: NO_CONCLUSION,
    evidence,
    writtenAtEpoch: nowEpochMs,
  });
  return { candidates, handle };
}

const ageDays = (thenMs: number, nowMs: number): string => (Math.max(0, nowMs - thenMs) / 86_400_000).toFixed(1);

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export function renderStanding(candidates: readonly StandingCandidate[], nowEpochMs: number): string {
  if (candidates.length === 0) return "";
  const lines = candidates.map((c) => {
    const v = c.verdict;
    let mark: string;
    if (v.status === "fresh") mark = "FRESH — evidence unchanged since";
    else if (v.status === "unauditable") mark = "UNAUDITABLE — the entry cites no evidence; treat as unverified";
    else {
      const parts: string[] = [];
      if (v.changed.length > 0) parts.push(`changed: ${v.changed.join(", ")}`);
      if (v.unresolved.length > 0) parts.push(`gone (erased/unknown): ${v.unresolved.join(", ")}`);
      mark = `STALE — do NOT reuse; ${parts.join("; ")}`;
    }
    const conclusion = hasConclusion(c.answer) ? `\n   → ${c.answer.answer.replace(/\n/g, "\n     ")}` : "";
    return (
      `  • asked ${ageDays(c.answer.writtenAtEpoch, nowEpochMs)}d ago ` +
      `(evidence overlap ${c.overlap.toFixed(2)}): "${oneLine(c.answer.question)}"\n   ${mark}${conclusion}`
    );
  });
  return `\n⟲ STANDING — you have been here before (surfaced, NOT substituted):\n${lines.join("\n")}\n`;
}
