export type ClaimBasis = "measured" | "derived" | "assumed";

export interface ClaimEvidence {
  readonly instrument: string;
  readonly ranged: readonly string[] | number;
  readonly cannotSee: string;
}

export interface Claim {
  readonly text: string;
  readonly basis: ClaimBasis;
  readonly assertsOver?: readonly string[];
  readonly evidence?: ClaimEvidence;
}

export interface ClaimVerdict {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly unmeasured: readonly string[];
}

export function checkClaim(c: Claim): ClaimVerdict {
  const problems: string[] = [];
  const unmeasured: string[] = [];

  if (c.text.trim() === "") problems.push("a claim with no text asserts nothing");

  if (c.basis === "measured" && c.evidence === undefined) {
    problems.push("basis is `measured` but no instrument is named — that is an inference, not a measurement");
  }
  if (c.evidence !== undefined) {
    if (c.evidence.instrument.trim() === "") problems.push("evidence names no instrument");
    if (c.evidence.cannotSee.trim() === "") {
      problems.push("evidence states no blind spot — a scope whose limits cannot be written down has not been identified");
    }
    const r = c.evidence.ranged;
    if (typeof r === "number") {
      if (!Number.isInteger(r) || r < 0) problems.push(`ranged must be a non-negative integer count, got ${String(r)}`);
      if (r === 0) problems.push("the instrument ranged over nothing — a claim from an empty population is vacuous");
      if (c.assertsOver !== undefined && c.assertsOver.length > 0) {
        problems.push("claim quantifies over named units but its evidence is only a count — containment cannot be checked");
      }
    } else {
      if (r.length === 0) problems.push("the instrument ranged over nothing — a claim from an empty population is vacuous");
      const covered = new Set(r);
      for (const u of c.assertsOver ?? []) if (!covered.has(u)) unmeasured.push(u);
      if (unmeasured.length > 0) {
        problems.push(`claim asserts over ${unmeasured.length} unit(s) the instrument never saw: ${unmeasured.join(", ")}`);
      }
    }
  }
  return { ok: problems.length === 0, problems, unmeasured };
}

export function renderClaim(c: Claim): string {
  const v = checkClaim(c);
  if (!v.ok) return `MAY NOT BE PUBLISHED AS WRITTEN — ${v.problems.join("; ")}`;
  const scope =
    c.evidence === undefined
      ? c.basis
      : `${c.basis}; ${c.evidence.instrument}; ranged over ${typeof c.evidence.ranged === "number" ? c.evidence.ranged : c.evidence.ranged.length}; cannot see: ${c.evidence.cannotSee}`;
  return `${c.text} [${scope}]`;
}

export function narrowToEvidence(c: Claim): Claim {
  const r = c.evidence?.ranged;
  if (c.assertsOver === undefined || typeof r === "number" || r === undefined) return c;
  const covered = new Set(r);
  const kept = c.assertsOver.filter((u) => covered.has(u));
  return kept.length === c.assertsOver.length ? c : { ...c, assertsOver: kept };
}

export { findRequotations, validateRegister } from "./withdrawn.js";
export type { WithdrawnClaim, Requotation } from "./withdrawn.js";
