import type { ErasureListener } from "../erasure/bus.js";
import type { CascadeReport } from "../derived/store.js";
import type { InjectionResult } from "../inject/proactive_injector.js";
import type { DriftReport } from "../provenance/derived_number.js";
import type { StandingCandidate } from "../standing/standing_answers.js";
import type { OutboundVerdict } from "../coordination/outbound.js";
import type { ServiceLevelVerdict } from "../service/service_level.js";
import type { PagingAction } from "../tiers/membership.js";
import type { FeedConsumed, FeedFault } from "../erasure/feed_watcher.js";

interface Dated {
  readonly atEpoch?: number;
}

export type AuditEvent =
  | (Dated & { readonly kind: "erasure"; readonly cellId: string })
  | (Dated & { readonly kind: "cascade"; readonly erased: string; readonly forgotten: readonly string[]; readonly refused: number; readonly failed: number })
  | (Dated & {
      readonly kind: "injection";
      readonly fired: boolean;
      readonly injected: readonly string[];
      readonly dropped: Readonly<Record<string, number>>;
      readonly budgeted: boolean;
      readonly scope?: string;
      readonly cueChars: number;
    })
  | (Dated & { readonly kind: "drift"; readonly label: string; readonly ok: number; readonly drifted: number; readonly absent: number; readonly covered: number; readonly uncovered: number })
  | (Dated & { readonly kind: "standing"; readonly fresh: number; readonly stale: number; readonly unauditable: number })
  | (Dated & { readonly kind: "outbound"; readonly to: string; readonly allowed: boolean; readonly refusals: readonly string[] })
  | (Dated & { readonly kind: "service"; readonly route: string; readonly within: boolean | undefined })
  | (Dated & { readonly kind: "paging"; readonly cellId: string; readonly from: string; readonly to: string; readonly reason: string; readonly outcome: "applied" | "failed" })
  | (Dated & { readonly kind: "reconcile"; readonly method: "index" | "recall" | "listing" | "none"; readonly checked: number; readonly live: number; readonly erased: readonly string[]; readonly suspect: readonly string[]; readonly restored: readonly string[]; readonly unverifiable: number; readonly deferred: number; readonly withheld: readonly string[]; readonly persisted?: boolean; readonly storeFault?: string; readonly loadFault?: string; readonly loadNote?: string })
  | (Dated & { readonly kind: "release"; readonly cellId: string; readonly reason: string; readonly outcome: "released"; readonly persisted: boolean; readonly storeFault?: string })
  | (Dated & { readonly kind: "release"; readonly cellId: string; readonly reason: string; readonly outcome: "not-withheld" })
  | (Dated & { readonly kind: "withheld"; readonly cellId: string; readonly outcome: "erased"; readonly persisted: boolean; readonly storeFault?: string })
  | (Dated & { readonly kind: "withheld"; readonly outcome: "lost"; readonly reason: string; readonly quarantined?: string })
  | (Dated & { readonly kind: "feed"; readonly outcome: "consumed"; readonly cellId: string; readonly complete: boolean; readonly reason?: string; readonly source: string; readonly forgottenAt: string; readonly lagMs: number })
  | (Dated & { readonly kind: "feed"; readonly outcome: "malformed" | "foreign" })
  | (Dated & { readonly kind: "feed"; readonly outcome: "live-after-forget"; readonly cellId: string });

export type AuditKind = AuditEvent["kind"];

export interface AuditTrailOptions {
  readonly clock?: () => number;
  readonly maxEvents?: number;
}

export const DEFAULT_MAX_EVENTS = 10_000;

export class AuditTrail {
  private readonly log: AuditEvent[] = [];
  private droppedCount = 0;
  private readonly max: number;

  constructor(private readonly opts: AuditTrailOptions = {}) {
    this.max = Number.isInteger(opts.maxEvents) && (opts.maxEvents as number) >= 1 ? (opts.maxEvents as number) : DEFAULT_MAX_EVENTS;
  }

  record(event: AuditEvent): void {
    if (this.log.length >= this.max) {
      this.droppedCount++;
      return;
    }
    this.log.push(event.atEpoch === undefined ? this.stamp(event) : event);
  }

  private stamp(event: AuditEvent): AuditEvent {
    const clock = this.opts.clock;
    if (clock === undefined) return event;
    let at: number;
    try {
      at = clock();
    } catch {
      return event;
    }
    return Number.isFinite(at) ? { ...event, atEpoch: at } : event;
  }

  events(): readonly AuditEvent[] {
    return [...this.log];
  }

  get size(): number {
    return this.log.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  drain(): AuditEvent[] {
    const out = this.log.splice(0);
    this.droppedCount = 0;
    return out;
  }

  erasureListener(): ErasureListener {
    return (cellId) => {
      this.record({ kind: "erasure", cellId });
    };
  }

  cascadeListener(): (report: CascadeReport) => void {
    return (r) => {
      this.record({ kind: "cascade", erased: r.erased, forgotten: [...r.forgotten], refused: r.refused.length, failed: r.failed.length });
    };
  }

  recordInjection(result: InjectionResult, atEpoch?: number): void {
    const dropped: Record<string, number> = {};
    for (const d of result.dropped) dropped[d.reason] = (dropped[d.reason] ?? 0) + 1;
    this.record({
      kind: "injection",
      fired: result.injected.length > 0,
      injected: result.injected.map((m) => m.cellId),
      dropped,
      budgeted: result.usedTokens !== undefined,
      ...(result.scope !== undefined ? { scope: result.scope } : {}),
      cueChars: result.cue.length,
      ...(atEpoch !== undefined ? { atEpoch } : {}),
    });
  }

  recordDrift(report: DriftReport, label: string, atEpoch?: number): void {
    let ok = 0;
    let drifted = 0;
    let absent = 0;
    for (const v of report.verdicts) {
      if (v.kind === "ok") ok++;
      else if (v.kind === "drift") drifted++;
      else absent++;
    }
    this.record({ kind: "drift", label, ok, drifted, absent, covered: report.covered, uncovered: report.uncovered, ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }

  recordStanding(candidates: readonly StandingCandidate[], atEpoch?: number): void {
    let fresh = 0;
    let stale = 0;
    let unauditable = 0;
    for (const c of candidates) {
      if (c.verdict.status === "fresh") fresh++;
      else if (c.verdict.status === "stale") stale++;
      else unauditable++;
    }
    this.record({ kind: "standing", fresh, stale, unauditable, ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }

  recordOutbound(to: string, verdict: OutboundVerdict, atEpoch?: number): void {
    this.record({ kind: "outbound", to, allowed: verdict.allowed, refusals: verdict.refusals.map((r) => r.policy), ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }

  recordPaging(action: PagingAction, outcome: "applied" | "failed", atEpoch?: number): void {
    this.record({ kind: "paging", cellId: action.cellId, from: action.from, to: action.to, reason: action.reason, outcome, ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }

  recordFeed(item: FeedConsumed, atEpoch?: number): void {
    this.record({ kind: "feed", outcome: "consumed", cellId: item.line.cellId, complete: item.line.complete, ...(item.line.reason !== undefined ? { reason: item.line.reason } : {}), source: item.line.source, forgottenAt: item.line.at, lagMs: item.lagMs, ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }

  recordFeedFault(fault: FeedFault, atEpoch?: number): void {
    this.record({ kind: "feed", outcome: fault.outcome, ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }

  recordReconcile(run: { readonly method: "index" | "recall" | "listing" | "none"; readonly checked: number; readonly live: number; readonly erased: readonly string[]; readonly suspect: readonly string[]; readonly restored: readonly string[]; readonly unverifiable: number; readonly deferred: number; readonly withheld: readonly string[]; readonly persisted?: boolean; readonly storeFault?: string; readonly loadFault?: string; readonly loadNote?: string }, atEpoch?: number): void {
    this.record({ kind: "reconcile", method: run.method, checked: run.checked, live: run.live, erased: [...run.erased], suspect: [...run.suspect], restored: [...run.restored], unverifiable: run.unverifiable, deferred: run.deferred, withheld: [...run.withheld], ...(run.persisted !== undefined ? { persisted: run.persisted } : {}), ...(run.storeFault !== undefined ? { storeFault: run.storeFault } : {}), ...(run.loadFault !== undefined ? { loadFault: run.loadFault } : {}), ...(run.loadNote !== undefined ? { loadNote: run.loadNote } : {}), ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }

  recordRelease(r: { readonly cellId: string; readonly reason: string; readonly outcome: "released"; readonly persisted: boolean; readonly storeFault?: string } | { readonly cellId: string; readonly reason: string; readonly outcome: "not-withheld" }, atEpoch?: number): void {
    this.record({ kind: "release", ...r, ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }

  recordWithheldLost(r: { readonly reason: string; readonly quarantined?: string }, atEpoch?: number): void {
    this.record({ kind: "withheld", outcome: "lost", reason: r.reason, ...(r.quarantined !== undefined ? { quarantined: r.quarantined } : {}), ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }

  recordWithheldErased(r: { readonly cellId: string; readonly persisted: boolean; readonly storeFault?: string }, atEpoch?: number): void {
    this.record({ kind: "withheld", cellId: r.cellId, outcome: "erased", persisted: r.persisted, ...(r.storeFault !== undefined ? { storeFault: r.storeFault } : {}), ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }

  recordFeedLive(cellId: string, atEpoch?: number): void {
    this.record({ kind: "feed", outcome: "live-after-forget", cellId, ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }

  recordServiceLevels(verdicts: readonly ServiceLevelVerdict[], atEpoch?: number): void {
    for (const v of verdicts) this.record({ kind: "service", route: v.route, within: v.within, ...(atEpoch !== undefined ? { atEpoch } : {}) });
  }
}
