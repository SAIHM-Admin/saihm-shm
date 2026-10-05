export interface ClaimKind {
  readonly kind: string;
  readonly pattern: RegExp;
}

export const DEFAULT_CLAIM_KINDS: readonly ClaimKind[] = [
  { kind: "gitsha", pattern: /[0-9a-f]{7}/ },
  { kind: "path", pattern: /[A-Za-z0-9._/-]+\.(?:ts|tsx|js|mjs|md|json|sh|py|toml|yaml|yml)/ },
  { kind: "semver", pattern: /v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/ },
];

export const DEFAULT_PROVENANCE_MARKERS: readonly RegExp[] = [
  /\b(?:measured|verified|confirmed|observed|probed?|checked|as of)\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{2}:\d{2}(?::\d{2})?Z?\b/,
  /\b(?:git|npx|node|npm|cargo|kubectl|curl|sha256sum|wc|ls)\s/,
  /@\s?\d/,
];

export interface ProvenanceConfig {
  readonly kinds: readonly ClaimKind[];
  readonly markers: readonly RegExp[];
  readonly windowChars: number;
  readonly tokenPattern: RegExp;
}

export const DEFAULT_PROVENANCE: ProvenanceConfig = {
  kinds: DEFAULT_CLAIM_KINDS,
  markers: DEFAULT_PROVENANCE_MARKERS,
  windowChars: 80,
  tokenPattern: /`([^`\n]{1,120})`/g,
};

export interface LiveStateClaim {
  readonly kind: string;
  readonly value: string;
  readonly line: number;
  readonly column: number;
  readonly provenanced: boolean;
}

export interface KindTally {
  readonly total: number;
  readonly unprovenanced: number;
}

export interface ProvenanceReport {
  readonly claims: readonly LiveStateClaim[];
  readonly unprovenanced: readonly LiveStateClaim[];
  readonly vacuous: boolean;
  readonly byKind: ReadonlyMap<string, KindTally>;
}

const stateless = (r: RegExp): RegExp => new RegExp(r.source, r.flags.replace(/[gy]/g, ""));

const anchored = (r: RegExp): RegExp => new RegExp(`^(?:${r.source})$`, r.flags.replace(/[gy]/g, ""));

export function normalizeProvenance(cfg: Partial<ProvenanceConfig> = {}): ProvenanceConfig {
  const kinds = (cfg.kinds ?? DEFAULT_PROVENANCE.kinds).map((k) => ({
    kind: k.kind,
    pattern: anchored(k.pattern),
  }));
  if (kinds.length === 0) {
    throw new RangeError("normalizeProvenance: no claim kinds, so nothing could ever be flagged and every text would report a vacuous pass");
  }
  const markers = (cfg.markers ?? DEFAULT_PROVENANCE.markers).map(stateless);
  const w = cfg.windowChars ?? DEFAULT_PROVENANCE.windowChars;
  if (!Number.isFinite(w) || w < 0) {
    throw new RangeError(`normalizeProvenance: windowChars must be a finite count, got ${String(cfg.windowChars)}`);
  }
  const tp = cfg.tokenPattern ?? DEFAULT_PROVENANCE.tokenPattern;
  const tokenPattern = tp.flags.includes("g") ? tp : new RegExp(tp.source, `${tp.flags}g`);
  return { kinds, markers, windowChars: Math.floor(w), tokenPattern };
}

export function findLiveStateClaims(
  text: string,
  cfg: Partial<ProvenanceConfig> = {},
): LiveStateClaim[] {
  const c = normalizeProvenance(cfg);
  const out: LiveStateClaim[] = [];
  const lines = text.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]!;
    const tokenizer = new RegExp(c.tokenPattern.source, c.tokenPattern.flags);
    for (const m of line.matchAll(tokenizer)) {
      const value = (m[1] ?? m[0]).trim();
      if (value.length === 0) continue;
      const kind = c.kinds.find((k) => k.pattern.test(value));
      if (!kind) continue;
      const at = m.index ?? 0;
      const window = line.slice(Math.max(0, at - c.windowChars), at + m[0].length + c.windowChars);
      out.push({
        kind: kind.kind,
        value,
        line: ln + 1,
        column: at + 1,
        provenanced: c.markers.some((r) => r.test(window)),
      });
    }
  }
  return out;
}

export function assessProvenance(
  text: string,
  cfg: Partial<ProvenanceConfig> = {},
): ProvenanceReport {
  const claims = findLiveStateClaims(text, cfg);
  const byKind = new Map<string, KindTally>();
  for (const cl of claims) {
    const prev = byKind.get(cl.kind) ?? { total: 0, unprovenanced: 0 };
    byKind.set(cl.kind, {
      total: prev.total + 1,
      unprovenanced: prev.unprovenanced + (cl.provenanced ? 0 : 1),
    });
  }
  return {
    claims,
    unprovenanced: claims.filter((cl) => !cl.provenanced),
    vacuous: claims.length === 0,
    byKind,
  };
}

export class UnprovenancedClaimError extends Error {
  readonly report: ProvenanceReport;
  constructor(report: ProvenanceReport) {
    const shown = report.unprovenanced
      .slice(0, 5)
      .map((c) => `  ${c.line}:${c.column}  ${c.value}  (${c.kind})`)
      .join("\n");
    const more = report.unprovenanced.length > 5 ? `\n  ...and ${report.unprovenanced.length - 5} more` : "";
    super(
      `${report.unprovenanced.length} live-state claim(s) stored as a bare value:\n${shown}${more}\n` +
        `Each names something that will move. Record how it was obtained — a command, a date, a ` +
        `clock — beside it, or the next reader cannot tell a current value from a stale one.`,
    );
    this.name = "UnprovenancedClaimError";
    this.report = report;
  }
}

export function requireProvenance(text: string, cfg: Partial<ProvenanceConfig> = {}): ProvenanceReport {
  const report = assessProvenance(text, cfg);
  if (report.unprovenanced.length > 0) throw new UnprovenancedClaimError(report);
  return report;
}

const claimKey = (c: { kind: string; value: string }): string => `${c.kind}\u0000${c.value}`;

export interface BudgetEntry {
  readonly kind: string;
  readonly value: string;
  readonly count: number;
  readonly note?: string;
}

export function unprovenancedBudget(text: string, cfg: Partial<ProvenanceConfig> = {}): BudgetEntry[] {
  const counts = new Map<string, BudgetEntry>();
  for (const c of assessProvenance(text, cfg).unprovenanced) {
    const prev = counts.get(claimKey(c));
    counts.set(claimKey(c), { kind: c.kind, value: c.value, count: (prev?.count ?? 0) + 1 });
  }
  return [...counts.values()];
}

export function newUnprovenancedAgainst(
  budget: readonly BudgetEntry[],
  after: string,
  cfg: Partial<ProvenanceConfig> = {},
): LiveStateClaim[] {
  const left = new Map<string, number>();
  for (const e of budget) left.set(claimKey(e), (left.get(claimKey(e)) ?? 0) + e.count);
  const added: LiveStateClaim[] = [];
  for (const c of assessProvenance(after, cfg).unprovenanced) {
    const n = left.get(claimKey(c)) ?? 0;
    if (n > 0) left.set(claimKey(c), n - 1);
    else added.push(c);
  }
  return added;
}

export function newUnprovenanced(
  before: string,
  after: string,
  cfg: Partial<ProvenanceConfig> = {},
): LiveStateClaim[] {
  return newUnprovenancedAgainst(unprovenancedBudget(before, cfg), after, cfg);
}

export function requireNoNewUnprovenanced(
  before: string,
  after: string,
  cfg: Partial<ProvenanceConfig> = {},
): LiveStateClaim[] {
  const added = newUnprovenanced(before, after, cfg);
  if (added.length > 0) {
    const byKind = new Map<string, KindTally>();
    for (const c of added) {
      const prev = byKind.get(c.kind) ?? { total: 0, unprovenanced: 0 };
      byKind.set(c.kind, { total: prev.total + 1, unprovenanced: prev.unprovenanced + 1 });
    }
    throw new UnprovenancedClaimError({ claims: added, unprovenanced: added, vacuous: false, byKind });
  }
  return added;
}
