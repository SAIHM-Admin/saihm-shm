export type Tier = "hot" | "warm" | "cold";

export const TIER_RANK: Readonly<Record<Tier, number>> = { cold: 0, warm: 1, hot: 2 };

export interface TierPolicy {
  readonly hotMinAccesses: number;
  readonly hotWindowHours: number;
  readonly warmWindowHours: number;
}

export interface TierSignals {
  readonly cellId: string;
  readonly ingestEpoch?: number;
  readonly salient: boolean;
  readonly accesses?: { readonly count: number; readonly lastEpoch?: number };
}

export interface TierDecision {
  readonly cellId: string;
  readonly tier: Tier;
  readonly reason: string;
}

export interface TierState {
  readonly hot: ReadonlySet<string>;
  readonly warm: ReadonlySet<string>;
}

export interface PagingAction {
  readonly cellId: string;
  readonly from: Tier;
  readonly to: Tier;
  readonly reason: string;
}

export interface TierPlan {
  readonly nowEpoch: number;
  readonly policy: TierPolicy;
  readonly accessesObserved: boolean;
  readonly decisions: readonly TierDecision[];
  readonly byTier: Readonly<Record<Tier, number>>;
  readonly current: Readonly<Record<Tier, number>>;
  readonly promotions: readonly PagingAction[];
  readonly evictions: readonly PagingAction[];
  readonly unchanged: number;
  readonly notes: readonly string[];
}

const finiteNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function validateTierPolicy(p: TierPolicy): void {
  if (!Number.isInteger(p.hotMinAccesses) || p.hotMinAccesses < 0) throw new Error(`tier policy: hotMinAccesses must be a non-negative integer (got ${String(p.hotMinAccesses)})`);
  if (!finiteNonNeg(p.hotWindowHours)) throw new Error(`tier policy: hotWindowHours must be finite and non-negative (got ${String(p.hotWindowHours)})`);
  if (!finiteNonNeg(p.warmWindowHours)) throw new Error(`tier policy: warmWindowHours must be finite and non-negative (got ${String(p.warmWindowHours)})`);
}

export function tierOf(s: TierSignals, policy: TierPolicy, nowEpoch: number): TierDecision {
  validateTierPolicy(policy);
  const acc = s.accesses;
  const sinceAccess = acc?.lastEpoch !== undefined ? nowEpoch - acc.lastEpoch : undefined;
  const sinceIngest = s.ingestEpoch !== undefined ? nowEpoch - s.ingestEpoch : undefined;
  if (acc !== undefined && sinceAccess !== undefined && acc.count >= policy.hotMinAccesses && sinceAccess <= policy.hotWindowHours) {
    return { cellId: s.cellId, tier: "hot", reason: `accessed ${acc.count}× — last ${sinceAccess}h ago (≤ ${policy.hotWindowHours}h)` };
  }
  if (s.salient) return { cellId: s.cellId, tier: "warm", reason: "salient: the namespace policy keeps it resident (never cold)" };
  if (sinceAccess !== undefined && sinceAccess <= policy.warmWindowHours) {
    return { cellId: s.cellId, tier: "warm", reason: `last accessed ${sinceAccess}h ago (≤ ${policy.warmWindowHours}h)` };
  }
  if (sinceIngest !== undefined && sinceIngest <= policy.warmWindowHours) {
    return { cellId: s.cellId, tier: "warm", reason: `ingested ${sinceIngest}h ago (≤ ${policy.warmWindowHours}h)` };
  }
  if (sinceIngest === undefined && sinceAccess === undefined) {
    return { cellId: s.cellId, tier: "cold", reason: acc === undefined ? "unstamped; access unobserved" : "unstamped; never accessed" };
  }
  const latest = Math.min(...[sinceIngest, sinceAccess].filter((x): x is number => x !== undefined));
  return { cellId: s.cellId, tier: "cold", reason: `last activity ${latest}h ago (> ${policy.warmWindowHours}h)` };
}

const currentTierOf = (id: string, state: TierState): Tier => (state.hot.has(id) ? "hot" : state.warm.has(id) ? "warm" : "cold");

export function planTiers(signals: readonly TierSignals[], state: TierState, policy: TierPolicy, nowEpoch: number, accessesObserved: boolean): TierPlan {
  validateTierPolicy(policy);
  if (!Number.isFinite(nowEpoch)) throw new Error(`tier plan: nowEpoch must be finite (got ${String(nowEpoch)})`);
  if (!accessesObserved) {
    const carrying = signals.filter((s) => s.accesses !== undefined).length;
    if (carrying > 0) throw new Error(`tier plan: accessesObserved=false but ${carrying} signal(s) carry accesses — omit accesses when the instrument was absent, or pass accessesObserved=true`);
  }
  const decisions: TierDecision[] = [];
  const promotions: PagingAction[] = [];
  const evictions: PagingAction[] = [];
  let unchanged = 0;
  const byTier: Record<Tier, number> = { hot: 0, warm: 0, cold: 0 };
  const current: Record<Tier, number> = { hot: 0, warm: 0, cold: 0 };
  for (const s of signals) {
    const d = tierOf(s, policy, nowEpoch);
    decisions.push(d);
    byTier[d.tier]++;
    const from = currentTierOf(s.cellId, state);
    current[from]++;
    if (TIER_RANK[d.tier] > TIER_RANK[from]) promotions.push({ cellId: s.cellId, from, to: d.tier, reason: d.reason });
    else if (TIER_RANK[d.tier] < TIER_RANK[from]) evictions.push({ cellId: s.cellId, from, to: d.tier, reason: d.reason });
    else unchanged++;
  }
  const notes: string[] = [];
  if (!accessesObserved) notes.push("access frequency unobserved (no compliance trail): no cell can qualify as hot on access; warm follows salience and ingest only");
  const unstamped = signals.filter((s) => s.ingestEpoch === undefined).length;
  if (unstamped > 0) notes.push(`${unstamped} cell(s) carry no ingest epoch: recency cannot keep them warm`);
  return { nowEpoch, policy, accessesObserved, decisions, byTier, current, promotions, evictions, unchanged, notes };
}

export function renderTierPlan(p: TierPlan): string {
  const lines: string[] = [];
  lines.push(
    `TIERS @${p.nowEpoch}h — target hot ${p.byTier.hot} · warm ${p.byTier.warm} · cold ${p.byTier.cold} (current hot ${p.current.hot} · warm ${p.current.warm} · cold ${p.current.cold}) · ${p.promotions.length} promotion(s) · ${p.evictions.length} eviction(s) · ${p.unchanged} unchanged · accesses ${p.accessesObserved ? "observed" : "UNOBSERVED"}`,
  );
  lines.push(`  policy: hot ≥ ${p.policy.hotMinAccesses} access(es) within ${p.policy.hotWindowHours}h · warm within ${p.policy.warmWindowHours}h`);
  for (const a of p.promotions) lines.push(`  ↑ ${a.cellId}  ${a.from} → ${a.to}  ${a.reason}`);
  for (const a of p.evictions) lines.push(`  ↓ ${a.cellId}  ${a.from} → ${a.to}  ${a.reason}`);
  if (p.notes.length > 0) {
    lines.push("  notes:");
    for (const n of p.notes) lines.push(`    ${n}`);
  }
  return lines.join("\n");
}
