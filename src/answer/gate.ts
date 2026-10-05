import type { AbstentionConfig, GroundedAnswer, RawAnswer } from "./types.js";
import { DEFAULT_ABSTENTION } from "./types.js";

function safeMinConfidence(minConfidence: number): number {
  return Number.isFinite(minConfidence)
    ? Math.min(1, Math.max(0, minConfidence))
    : DEFAULT_ABSTENTION.minConfidence;
}

export function decideAbstention(
  raw: RawAnswer,
  retrievedCellIds: readonly string[],
  cfg: AbstentionConfig,
): GroundedAnswer {
  if (!isWellFormed(raw)) return { answered: false, reason: "malformed-answer" };
  if (raw.abstained) return { answered: false, reason: "answerer-abstained" };
  if (raw.confidence < safeMinConfidence(cfg.minConfidence)) {
    return { answered: false, reason: "below-confidence-threshold" };
  }

  const allowed = new Set(retrievedCellIds);
  const citations: string[] = [];
  const dropped: string[] = [];
  for (const id of raw.citedCellIds) (allowed.has(id) ? citations : dropped).push(id);

  if (cfg.requireCitation && citations.length === 0) {
    return { answered: false, reason: "ungrounded" };
  }
  return { answered: true, text: raw.text, citations, droppedCitations: dropped };
}

function isWellFormed(raw: RawAnswer): boolean {
  return (
    typeof raw?.text === "string" &&
    typeof raw.abstained === "boolean" &&
    typeof raw.confidence === "number" &&
    Number.isFinite(raw.confidence) &&
    raw.confidence >= 0 &&
    raw.confidence <= 1 &&
    Array.isArray(raw.citedCellIds) &&
    raw.citedCellIds.every((c) => typeof c === "string")
  );
}
