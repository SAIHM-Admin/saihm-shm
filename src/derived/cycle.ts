import type { BodyPair } from "../consolidate/body_redundancy.js";
import type { TierPlan } from "../tiers/membership.js";
import type { ThreadAccount } from "../assemble/thread.js";
import type { Scope } from "../retrieval/scope.js";
import { admitsSafely } from "../retrieval/scope.js";
import type { MintedRecord } from "./ledger.js";
import type { SaihmDerivedStore, CommitReceipt } from "./store.js";
import type { DerivedKind } from "./codec.js";

export interface ConsolidationProposal {
  readonly id: string;
  readonly kind: "merge" | "distill";
  readonly sources: readonly string[];
  readonly reason: string;
  readonly namespace?: string;
  readonly threads?: readonly string[];
  readonly openMembers?: readonly string[];
  readonly retire: boolean;
}

export interface PlanInput {
  readonly pairs?: readonly BodyPair[];
  readonly threads?: readonly { readonly slug: string; readonly account: ThreadAccount }[];
  readonly derived: readonly MintedRecord[];
  readonly retirements: ReadonlyMap<string, string>;
}

export interface PlanOptions {
  readonly scope?: Scope;
  readonly maxProposals?: number;
  readonly minThreadMembers?: number;
  readonly maxOpenMembers?: number;
}

function proposalId(kind: string, sources: readonly string[]): string {
  return `${kind}:${[...sources].sort().join("+").slice(0, 200)}`;
}

function clustersOf(pairs: readonly BodyPair[]): { namespace: string; members: string[] }[] {
  const parent = new Map<string, string>();
  const ns = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    while (r !== (parent.get(r) ?? r)) r = parent.get(r) ?? r;
    let cur = x;
    while (cur !== r) { const nx = parent.get(cur) ?? cur; parent.set(cur, r); cur = nx; }
    return r;
  };
  for (const p of pairs) {
    parent.set(p.a, parent.get(p.a) ?? p.a);
    parent.set(p.b, parent.get(p.b) ?? p.b);
    ns.set(p.a, p.namespace); ns.set(p.b, p.namespace);
    const ra = find(p.a), rb = find(p.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of [...parent.keys()].sort()) {
    const r = find(id);
    const g = groups.get(r);
    if (g) g.push(id); else groups.set(r, [id]);
  }
  return [...groups.values()].filter((m) => m.length >= 2).map((m) => ({ namespace: ns.get(m[0]!) ?? "unknown", members: m.sort() }));
}

export function planConsolidation(input: PlanInput, opts: PlanOptions = {}): ConsolidationProposal[] {
  const max = Number.isFinite(opts.maxProposals) && (opts.maxProposals as number) >= 1 ? Math.floor(opts.maxProposals as number) : 20;
  const minMembers = Number.isFinite(opts.minThreadMembers) && (opts.minThreadMembers as number) >= 2 ? Math.floor(opts.minThreadMembers as number) : 2;
  const maxOpenMembers = Number.isFinite(opts.maxOpenMembers) && (opts.maxOpenMembers as number) >= 0 ? Math.floor(opts.maxOpenMembers as number) : 0;
  const scope = opts.scope;
  const admitted = (ids: readonly string[]) => ids.every((id) => admitsSafely(scope, id));
  const covered = new Set<string>();
  for (const r of input.derived) {
    if (r.forgotten !== undefined) continue;
    covered.add([...r.sources.map((s) => s.cellId)].sort().join("+"));
  }
  const retired = (ids: readonly string[]) => ids.some((id) => input.retirements.has(id));
  const out: ConsolidationProposal[] = [];
  const seen = new Set<string>();
  const push = (p: ConsolidationProposal) => {
    if (seen.has(p.id) || out.length >= max) return;
    seen.add(p.id);
    out.push(p);
  };

  for (const c of clustersOf(input.pairs ?? [])) {
    const key = c.members.join("+");
    if (covered.has(key) || retired(c.members) || !admitted(c.members)) continue;
    push({
      id: proposalId("merge", c.members),
      kind: "merge",
      sources: c.members,
      namespace: c.namespace,
      reason: `${c.members.length} cells share body text (shingle jaccard/containment above threshold) in namespace ${c.namespace}`,
      retire: true,
    });
  }
  for (const t of input.threads ?? []) {
    const a = t.account;
    if (a.verdict !== "assembled" || a.status !== "closed" || a.members.length < minMembers) continue;
    const raw = a.members.filter((m) => m.derived === undefined);
    const members = raw.map((m) => m.cellId).sort();
    if (members.length < minMembers) continue;
    const key = members.join("+");
    if (covered.has(key) || retired(members) || !admitted(members)) continue;
    const openMembers = raw.filter((m) => m.stamp.status === "open").map((m) => m.cellId).sort();
    if (openMembers.length > maxOpenMembers) continue;
    push({
      id: proposalId("distill", members),
      kind: "distill",
      sources: members,
      threads: [t.slug],
      ...(openMembers.length > 0 ? { openMembers } : {}),
      reason:
        `thread ${t.slug} is closed with ${members.length} raw members and no distillation` +
        (openMembers.length > 0 ? `; ${openMembers.length} member(s) still stamped open — carry them as open` : ""),
      retire: false,
    });
  }
  return out;
}

export interface Distilled {
  readonly label: string;
  readonly text: string;
}
export type Distiller = (proposal: ConsolidationProposal) => Promise<Distilled | undefined>;

export type TierPassResult = TierPlan & { readonly applied?: { readonly promoted: number; readonly evicted: number; readonly failed: number } };
export type TierPass = (nowEpoch: number, apply: boolean) => Promise<TierPassResult>;
export type TierPassReport =
  | { readonly status: "not-configured" }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "ran"; readonly plan: TierPassResult }
  | { readonly status: "refused"; readonly reason: string };

export interface ConsolidationCycleOptions {
  readonly tiers?: TierPass;
}

export interface RunOptions {
  readonly nowEpoch: number;
  readonly dryRun?: boolean;
  readonly maxCommits?: number;
  readonly retire?: boolean;
  readonly plan?: PlanOptions;
  readonly tiers?: boolean;
}

export interface RunReport {
  readonly planned: readonly ConsolidationProposal[];
  readonly committed: readonly { readonly proposal: ConsolidationProposal; readonly receipt: CommitReceipt }[];
  readonly skipped: readonly { readonly proposal: ConsolidationProposal; readonly reason: string }[];
  readonly dryRun: boolean;
  readonly tiers: TierPassReport;
}

export class ConsolidationCycle {
  constructor(
    private readonly store: SaihmDerivedStore,
    private readonly gather: () => Promise<Omit<PlanInput, "derived" | "retirements">>,
    private readonly opts: ConsolidationCycleOptions = {},
  ) {}

  async plan(opts: PlanOptions = {}): Promise<ConsolidationProposal[]> {
    const evidence = await this.gather();
    const derived = await this.store.list();
    return planConsolidation({ ...evidence, derived, retirements: this.store.retirements() }, opts);
  }

  async commit(proposal: ConsolidationProposal, distilled: Distilled, opts: { nowEpoch: number; retire?: boolean }): Promise<CommitReceipt> {
    const kind: DerivedKind = proposal.kind === "merge" ? "merged" : "distilled";
    return this.store.commit({
      kind,
      label: distilled.label,
      text: distilled.text,
      sources: proposal.sources,
      nowEpoch: opts.nowEpoch,
      retire: opts.retire ?? proposal.retire,
      ...(proposal.threads !== undefined ? { threads: proposal.threads } : {}),
    });
  }

  async run(distill: Distiller, opts: RunOptions): Promise<RunReport> {
    const planned = await this.plan(opts.plan);
    const max = Number.isFinite(opts.maxCommits) && (opts.maxCommits as number) >= 0 ? Math.floor(opts.maxCommits as number) : 5;
    const committed: { proposal: ConsolidationProposal; receipt: CommitReceipt }[] = [];
    const skipped: { proposal: ConsolidationProposal; reason: string }[] = [];
    for (const p of planned) {
      if (opts.dryRun === true) { skipped.push({ proposal: p, reason: "dry run" }); continue; }
      if (committed.length >= max) { skipped.push({ proposal: p, reason: `maxCommits ${max} reached` }); continue; }
      let d: Distilled | undefined;
      try {
        d = await distill(p);
      } catch (e) {
        skipped.push({ proposal: p, reason: `distiller threw: ${(e as Error).message}` });
        continue;
      }
      if (d === undefined || typeof d.text !== "string" || d.text.trim() === "" || typeof d.label !== "string" || d.label.trim() === "") {
        skipped.push({ proposal: p, reason: "distiller returned no text — nothing is committed without content" });
        continue;
      }
      try {
        const receipt = await this.commit(p, d, { nowEpoch: opts.nowEpoch, ...(opts.retire !== undefined ? { retire: opts.retire } : {}) });
        committed.push({ proposal: p, receipt });
      } catch (e) {
        skipped.push({ proposal: p, reason: `commit refused: ${(e as Error).message}` });
      }
    }
    const tiers = await this.tierPass(opts);
    return { planned, committed, skipped, dryRun: opts.dryRun === true, tiers };
  }

  private async tierPass(opts: RunOptions): Promise<TierPassReport> {
    const pass = this.opts.tiers;
    if (pass === undefined) return { status: "not-configured" };
    if (opts.tiers === false) return { status: "skipped", reason: "tiers: false for this run" };
    try {
      return { status: "ran", plan: await pass(opts.nowEpoch, opts.dryRun !== true) };
    } catch (e) {
      return { status: "refused", reason: (e as Error).message };
    }
  }
}

export function renderRunReport(r: RunReport): string {
  const lines = [`CONSOLIDATION ${r.dryRun ? "DRY RUN" : "RUN"} — ${r.planned.length} planned · ${r.committed.length} committed · ${r.skipped.length} skipped`];
  for (const c of r.committed) lines.push(`  ✓ ${c.proposal.kind} ${c.proposal.sources.length} sources → ${c.receipt.cellId.slice(0, 12)}…${c.receipt.item.retires ? " (sources retired)" : ""}`);
  for (const s of r.skipped) lines.push(`  · ${s.proposal.kind} ${s.proposal.sources.length} sources — ${s.reason}`);
  const t = r.tiers;
  if (t.status === "ran") {
    const p = t.plan;
    lines.push(
      `  tiers ${p.applied === undefined ? "planned" : "applied"} @${p.nowEpoch}h — target hot ${p.byTier.hot} · warm ${p.byTier.warm} · cold ${p.byTier.cold} · ${p.promotions.length} promotion(s) · ${p.evictions.length} eviction(s)` +
        (p.applied === undefined ? "" : ` · applied ${p.applied.promoted} promoted / ${p.applied.evicted} evicted / ${p.applied.failed} failed`) +
        (p.accessesObserved ? "" : " · accesses UNOBSERVED"),
    );
  } else if (t.status === "refused") lines.push(`  tiers REFUSED — ${t.reason}`);
  else if (t.status === "skipped") lines.push(`  tiers skipped — ${t.reason}`);
  else lines.push("  tiers not configured");
  return lines.join("\n");
}
