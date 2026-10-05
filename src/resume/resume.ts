import { gateScope, renderGateVerdict, type GateScope } from "../gate/index.js";

export type ClaimVerdict = "holds" | "drifted" | "unverifiable" | "foreign";

export interface ResumeClaim {
  readonly id: string;
  readonly stated: string;
  readonly scope?: string;
  readonly how?: string;
}

export interface VerifiedClaim {
  readonly claim: ResumeClaim;
  readonly verdict: ClaimVerdict;
  readonly actual?: string;
  readonly note: string;
}

export interface ResumeReport {
  readonly claims: readonly VerifiedClaim[];
  readonly holds: number;
  readonly drifted: number;
  readonly unverifiable: number;
  readonly foreign: number;
  readonly coverage: number;
  readonly scope: GateScope;
  readonly safeToResume: boolean;
  readonly verdict: string;
}

export type Probe = () => string;

export interface VerifyOptions {
  readonly here?: string;
  readonly matches?: (stated: string, actual: string) => boolean;
}

const defaultMatches = (a: string, b: string): boolean => a.trim() === b.trim();

export function verifyResume(
  claims: readonly ResumeClaim[],
  probes: Readonly<Record<string, Probe>>,
  opts: VerifyOptions = {},
): ResumeReport {
  const here = opts.here;
  const matches = opts.matches ?? defaultMatches;
  const out: VerifiedClaim[] = [];
  let holds = 0, drifted = 0, unverifiable = 0, foreign = 0;

  for (const claim of claims) {
    if (claim.scope !== undefined && here !== undefined && claim.scope !== here) {
      foreign++;
      out.push({
        claim,
        verdict: "foreign",
        note: `FOREIGN — asserted of ${claim.scope}, and this is ${here}. Not checked here, and not evidence here.`,
      });
      continue;
    }
    const probe = Object.prototype.hasOwnProperty.call(probes, claim.id) ? probes[claim.id] : undefined;
    if (typeof probe !== "function") {
      unverifiable++;
      out.push({
        claim,
        verdict: "unverifiable",
        note: `UNVERIFIABLE — no probe for "${claim.id}"${claim.how === undefined ? "" : `; settle it with: ${claim.how}`}`,
      });
      continue;
    }
    let actual: string;
    try {
      actual = probe();
    } catch (e) {
      unverifiable++;
      out.push({
        claim,
        verdict: "unverifiable",
        note: `UNVERIFIABLE — the probe for "${claim.id}" threw (${(e as Error).message}); the claim is untested, not refuted`,
      });
      continue;
    }
    if (matches(claim.stated, actual)) {
      holds++;
      out.push({ claim, verdict: "holds", actual, note: `holds — ${claim.id} = ${actual}` });
    } else {
      drifted++;
      out.push({
        claim,
        verdict: "drifted",
        actual,
        note: `DRIFTED — ${claim.id}: surface says ${JSON.stringify(claim.stated)}, actual ${JSON.stringify(actual)}`,
      });
    }
  }

  const local = claims.length - foreign;
  const checked = holds + drifted;
  const scope = gateScope({
    unit: "claim",
    examined: claims.length,
    discriminating: checked,
    discriminator: "were in scope here AND had a probe that ran, so could have been found to drift",
  });
  const safeToResume = drifted === 0 && scope.conclusive;
  const head = renderGateVerdict(drifted === 0, scope, { pass: "RESUME SAFE", fail: "DRIFTED" });

  return {
    claims: out,
    holds,
    drifted,
    unverifiable,
    foreign,
    coverage: local === 0 ? 0 : checked / local,
    scope,
    safeToResume,
    verdict:
      `${head} · ${holds} hold, ${drifted} drifted, ${unverifiable} unverifiable, ${foreign} foreign` +
      ` · coverage ${(local === 0 ? 0 : (checked / local) * 100).toFixed(0)}% of local claims`,
  };
}

export function requireSafeResume(report: ResumeReport, context: string): void {
  if (report.safeToResume) return;
  const bad = report.claims.filter((c) => c.verdict === "drifted").map((c) => `  ${c.note}`).join("\n");
  throw new Error(
    `${context}: refusing to resume — ${report.verdict}\n${bad}\n` +
      `Re-derive the drifted claims before acting on this surface; a resume that carries one wrong ` +
      `live value spends the whole session acting on it.`,
  );
}
