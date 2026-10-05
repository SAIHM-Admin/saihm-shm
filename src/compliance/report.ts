import type { AuditEvent } from "./trail.js";

export type ComplianceSection = "erasure" | "cascade" | "injection" | "provenance" | "standing" | "outbound" | "service" | "paging" | "feed" | "reconciliation";
export type SectionStatus = "recorded" | "no-events" | "not-wired";

export interface ComplianceOptions {
  readonly fromEpoch?: number;
  readonly toEpoch?: number;
  readonly dropped?: number;
  readonly wired?: Partial<Record<ComplianceSection, boolean>>;
  readonly notes?: readonly string[];
  readonly feedWiring?: FeedWiring;
}

export type FeedWiring = "watching" | "opted-out" | "not-wired" | "unknown";

export interface ComplianceReport {
  readonly window: { readonly fromEpoch?: number; readonly toEpoch?: number };
  readonly events: number;
  readonly undated: number;
  readonly dropped: number;
  readonly complete: boolean;
  readonly erasure: { readonly status: SectionStatus; readonly events: number; readonly cells: readonly string[] };
  readonly cascade: { readonly status: SectionStatus; readonly events: number; readonly forgotten: number; readonly refused: number; readonly failed: number };
  readonly injection: {
    readonly status: SectionStatus;
    readonly turns: number;
    readonly fired: number;
    readonly silent: number;
    readonly budgeted: number;
    readonly scoped: number;
    readonly cells: number;
    readonly dropped: Readonly<Record<string, number>>;
  };
  readonly provenance: { readonly status: SectionStatus; readonly checks: number; readonly ok: number; readonly drifted: number; readonly absent: number; readonly covered: number; readonly uncovered: number };
  readonly standing: { readonly status: SectionStatus; readonly events: number; readonly fresh: number; readonly stale: number; readonly unauditable: number };
  readonly outbound: { readonly status: SectionStatus; readonly screened: number; readonly allowed: number; readonly refused: number; readonly byPolicy: Readonly<Record<string, number>> };
  readonly service: {
    readonly status: SectionStatus;
    readonly verdicts: number;
    readonly within: number;
    readonly breached: number;
    readonly noVerdict: number;
    readonly routes: Readonly<Record<string, "within" | "breached" | "no-verdict">>;
  };
  readonly paging: { readonly status: SectionStatus; readonly events: number; readonly promotions: number; readonly evictions: number; readonly failed: number; readonly byReason: Readonly<Record<string, number>> };
  readonly feed: {
    readonly status: SectionStatus;
    readonly lines: number;
    readonly consumed: number;
    readonly complete: number;
    readonly incomplete: number;
    readonly malformed: number;
    readonly foreign: number;
    readonly liveAfterForget: number;
    readonly maxLagMs: number;
    readonly cells: readonly string[];
    readonly wiring: FeedWiring;
    readonly bySource: Readonly<Record<string, number>>;
    readonly incompleteByReason: Readonly<Record<string, number>>;
    readonly incompleteAttestedLater: number;
  };
  readonly reconciliation: {
    readonly status: SectionStatus;
    readonly runs: number;
    readonly checked: number;
    readonly live: number;
    readonly erased: number;
    readonly withheld: number;
    readonly restored: number;
    readonly unverifiable: number;
    readonly deferred: number;
    readonly byMethod: Readonly<Record<string, number>>;
    readonly erasedCells: readonly string[];
    readonly withheldCells: readonly string[];
    readonly released: number;
    readonly releasedCells: readonly string[];
    readonly releaseRefused: number;
    readonly unpersisted: number;
    readonly durable: boolean | undefined;
    readonly lostDoubts: number;
  };
  readonly notes: readonly string[];
}

const inWindow = (e: AuditEvent, from: number | undefined, to: number | undefined): boolean =>
  e.atEpoch === undefined || ((from === undefined || e.atEpoch >= from) && (to === undefined || e.atEpoch <= to));

function status(events: number, section: ComplianceSection, wired: ComplianceOptions["wired"]): SectionStatus {
  if (events > 0) return "recorded";
  return wired?.[section] === false ? "not-wired" : "no-events";
}

const bump = (rec: Record<string, number>, key: string, by = 1): void => {
  rec[key] = (rec[key] ?? 0) + by;
};

const rank = (tier: string): number => (tier === "hot" ? 2 : tier === "warm" ? 1 : 0);

export function assembleComplianceReport(all: readonly AuditEvent[], opts: ComplianceOptions = {}): ComplianceReport {
  const from = Number.isFinite(opts.fromEpoch) ? opts.fromEpoch : undefined;
  const to = Number.isFinite(opts.toEpoch) ? opts.toEpoch : undefined;
  const events = all.filter((e) => inWindow(e, from, to));
  const undated = events.filter((e) => e.atEpoch === undefined).length;
  const dropped = Number.isInteger(opts.dropped) && (opts.dropped as number) > 0 ? (opts.dropped as number) : 0;

  const erasedCells = new Set<string>();
  let erasureEvents = 0;
  let cascadeEvents = 0;
  const cascadeForgotten = new Set<string>();
  let cascadeRefused = 0;
  let cascadeFailed = 0;
  let turns = 0;
  let fired = 0;
  let budgeted = 0;
  let scoped = 0;
  const injectedCells = new Set<string>();
  const injDropped: Record<string, number> = {};
  let checks = 0;
  const prov = { ok: 0, drifted: 0, absent: 0, covered: 0, uncovered: 0 };
  let standingEvents = 0;
  const standing = { fresh: 0, stale: 0, unauditable: 0 };
  let screened = 0;
  let allowed = 0;
  const byPolicy: Record<string, number> = {};
  let verdicts = 0;
  let within = 0;
  let breached = 0;
  let noVerdict = 0;
  const routes: Record<string, "within" | "breached" | "no-verdict"> = {};
  let pagingEvents = 0;
  let pagingPromotions = 0;
  let pagingEvictions = 0;
  let pagingFailed = 0;
  const pagingByReason: Record<string, number> = {};
  let feedLines = 0;
  let feedConsumed = 0;
  let feedComplete = 0;
  let feedIncomplete = 0;
  let feedMalformed = 0;
  let feedForeign = 0;
  let feedLive = 0;
  let feedMaxLag = 0;
  const feedCells = new Set<string>();
  const feedBySource: Record<string, number> = {};
  const feedIncompleteByReason: Record<string, number> = {};
  const feedUnattested = new Map<string, number>();
  let feedAttestedLater = 0;
  let reconRuns = 0;
  let reconChecked = 0;
  let reconLive = 0;
  let reconRestored = 0;
  let reconUnverifiable = 0;
  let reconDeferred = 0;
  const reconByMethod: Record<string, number> = {};
  const reconErased = new Set<string>();
  let reconWithheld: readonly string[] = [];
  const reconReleased = new Set<string>();
  let reconReleaseRefused = 0;
  let reconUnpersisted = 0;
  let reconDurable: boolean | undefined;
  let reconLost = 0;

  for (const e of events) {
    switch (e.kind) {
      case "erasure":
        erasureEvents++;
        erasedCells.add(e.cellId);
        break;
      case "cascade":
        cascadeEvents++;
        for (const id of e.forgotten) cascadeForgotten.add(id);
        cascadeRefused += e.refused;
        cascadeFailed += e.failed;
        break;
      case "injection":
        turns++;
        if (e.fired) fired++;
        if (e.budgeted) budgeted++;
        if (e.scope !== undefined) scoped++;
        for (const id of e.injected) injectedCells.add(id);
        for (const [reason, n] of Object.entries(e.dropped)) bump(injDropped, reason, n);
        break;
      case "drift":
        checks++;
        prov.ok += e.ok;
        prov.drifted += e.drifted;
        prov.absent += e.absent;
        prov.covered += e.covered;
        prov.uncovered += e.uncovered;
        break;
      case "standing":
        standingEvents++;
        standing.fresh += e.fresh;
        standing.stale += e.stale;
        standing.unauditable += e.unauditable;
        break;
      case "outbound":
        screened++;
        if (e.allowed) allowed++;
        for (const p of e.refusals) bump(byPolicy, p);
        break;
      case "service":
        verdicts++;
        if (e.within === true) within++;
        else if (e.within === false) breached++;
        else noVerdict++;
        routes[e.route] = e.within === true ? "within" : e.within === false ? "breached" : "no-verdict";
        break;
      case "paging": {
        pagingEvents++;
        if (e.outcome === "failed") pagingFailed++;
        else if (rank(e.to) > rank(e.from)) pagingPromotions++;
        else pagingEvictions++;
        bump(pagingByReason, e.reason);
        break;
      }
      case "reconcile":
        reconRuns++;
        reconChecked += e.checked;
        reconLive += e.live;
        reconRestored += e.restored.length;
        reconUnverifiable += e.unverifiable;
        reconDeferred += e.deferred;
        bump(reconByMethod, e.method);
        for (const id of e.erased) reconErased.add(id);
        reconWithheld = e.withheld;
        if (e.storeFault !== undefined) reconUnpersisted++;
        if (e.persisted !== undefined) reconDurable = e.persisted && e.storeFault === undefined;
        break;
      case "release":
        if (e.outcome === "released") {
          reconReleased.add(e.cellId);
          reconWithheld = reconWithheld.filter((id) => id !== e.cellId);
          if (e.storeFault !== undefined) reconUnpersisted++;
        } else reconReleaseRefused++;
        break;
      case "withheld":
        if (e.outcome === "lost") {
          reconLost++;
          break;
        }
        reconWithheld = reconWithheld.filter((id) => id !== e.cellId);
        if (e.storeFault !== undefined) reconUnpersisted++;
        break;
      case "feed":
        feedLines++;
        if (e.outcome === "consumed") {
          feedConsumed++;
          if (e.complete) {
            feedComplete++;
            feedAttestedLater += feedUnattested.get(e.cellId) ?? 0;
            feedUnattested.delete(e.cellId);
          } else {
            feedIncomplete++;
            bump(feedIncompleteByReason, e.reason ?? "unstated");
            feedUnattested.set(e.cellId, (feedUnattested.get(e.cellId) ?? 0) + 1);
          }
          feedCells.add(e.cellId);
          bump(feedBySource, e.source);
          if (e.lagMs > feedMaxLag) feedMaxLag = e.lagMs;
        } else if (e.outcome === "foreign") feedForeign++;
        else if (e.outcome === "malformed") feedMalformed++;
        else if (e.outcome === "live-after-forget") {
          feedLive++;
          feedCells.add(e.cellId);
        }
        break;
    }
  }

  const notes: string[] = [];
  if (dropped > 0) notes.push(`${dropped} event(s) dropped for capacity: every count is a lower bound`);
  if (undated > 0) notes.push(`${undated} undated event(s) included in the window (recorded through a listener with no clock)`);
  if (opts.wired === undefined) notes.push("wiring unknown to the composition root: a section with no events may be unwatched");
  if (feedIncomplete > 0) {
    const stated = Object.keys(feedIncompleteByReason).some((k) => k !== "unstated");
    notes.push(
      `${feedIncomplete} feed line(s) reported an INCOMPLETE erasure (tombstone; key not destroyed on the substrate): purged here, not erased there` +
        (stated ? ` — by reason ${kv(feedIncompleteByReason)} (not-attested: the substrate could not make the destruction durable, the forget is to be retried; not-found: no such cell, or already erased)` : "") +
        (feedAttestedLater > 0 ? `; ${feedAttestedLater} of them for a cell a later line attested erased` : ""),
    );
  }
  if (feedForeign > 0) notes.push(`${feedForeign} foreign feed line(s) refused: another identity's lines in this feed are a wiring fault`);
  if (feedLive > 0) notes.push(`${feedLive} consumed feed line(s) named a cell still LIVE in the substrate at open: a reported forget that did not take; the cell is served`);
  if (reconErased.size > 0) notes.push(`${reconErased.size} copied row(s) erased by reconciliation: forgotten on the substrate's index with no erasure line seen; purged here`);
  if (reconWithheld.length > 0) notes.push(`${reconWithheld.length} copied row(s) WITHHELD by reconciliation: the substrate no longer returns them for their own text and no erasure line was seen — a doubt, served again when a later run finds them`);
  if (reconReleased.size > 0) notes.push(`${reconReleased.size} withheld row(s) RELEASED by the composition root's explicit assertion (session.release; reasons on the trail): served again — a release lifts a doubt, it is not an exemption`);
  if (reconReleaseRefused > 0) notes.push(`${reconReleaseRefused} release(s) REFUSED: the row was not withheld — a release of nothing is a wiring smell`);
  if (reconUnpersisted > 0) notes.push(`${reconUnpersisted} write(s) of the withheld set failed (after a run, a release or an erasure): those doubts are per process until a write succeeds`);
  if (reconDurable === false && reconUnpersisted === 0 && reconWithheld.length > 0) notes.push(`the withheld set is per process (no durable store wired): a restart releases every doubt — wire the default file store to keep them`);
  if (reconLost > 0) notes.push(`${reconLost} open(s) could not load the persisted withheld set: every doubt held before such an open is LOST (the unreadable file was quarantined beside the store; the trail names it); rows no longer named as candidates cannot be re-raised by evidence — \`durable\` speaks only of what was written since`);
  if (reconUnverifiable > 0) notes.push(`${reconUnverifiable} reconciliation candidate(s) UNVERIFIABLE (not listed, capped or failed probe, or no probe): unchanged, still served`);
  for (const n of opts.notes ?? []) notes.push(n);

  return {
    window: { ...(from !== undefined ? { fromEpoch: from } : {}), ...(to !== undefined ? { toEpoch: to } : {}) },
    events: events.length,
    undated,
    dropped,
    complete: dropped === 0,
    erasure: { status: status(erasureEvents, "erasure", opts.wired), events: erasureEvents, cells: [...erasedCells].sort() },
    cascade: { status: status(cascadeEvents, "cascade", opts.wired), events: cascadeEvents, forgotten: cascadeForgotten.size, refused: cascadeRefused, failed: cascadeFailed },
    injection: { status: status(turns, "injection", opts.wired), turns, fired, silent: turns - fired, budgeted, scoped, cells: injectedCells.size, dropped: injDropped },
    provenance: { status: status(checks, "provenance", opts.wired), checks, ...prov },
    standing: { status: status(standingEvents, "standing", opts.wired), events: standingEvents, ...standing },
    outbound: { status: status(screened, "outbound", opts.wired), screened, allowed, refused: screened - allowed, byPolicy },
    service: { status: status(verdicts, "service", opts.wired), verdicts, within, breached, noVerdict, routes },
    paging: { status: status(pagingEvents, "paging", opts.wired), events: pagingEvents, promotions: pagingPromotions, evictions: pagingEvictions, failed: pagingFailed, byReason: pagingByReason },
    reconciliation: {
      status: status(reconRuns, "reconciliation", opts.wired), runs: reconRuns, checked: reconChecked, live: reconLive, erased: reconErased.size, withheld: reconWithheld.length,
      restored: reconRestored, unverifiable: reconUnverifiable, deferred: reconDeferred, byMethod: reconByMethod, erasedCells: [...reconErased].sort(), withheldCells: [...reconWithheld].sort(),
      released: reconReleased.size, releasedCells: [...reconReleased].sort(), releaseRefused: reconReleaseRefused, unpersisted: reconUnpersisted, durable: reconDurable, lostDoubts: reconLost,
    },
    feed: {
      status: status(feedLines, "feed", opts.wired), lines: feedLines, consumed: feedConsumed, complete: feedComplete, incomplete: feedIncomplete, malformed: feedMalformed, foreign: feedForeign, liveAfterForget: feedLive, maxLagMs: feedMaxLag, cells: [...feedCells].sort(),
      wiring: opts.feedWiring ?? (opts.wired?.feed === true ? "watching" : opts.wired?.feed === false ? "not-wired" : "unknown"),
      bySource: feedBySource,
      incompleteByReason: feedIncompleteByReason,
      incompleteAttestedLater: feedAttestedLater,
    },
    notes,
  };
}

const kv = (rec: Readonly<Record<string, number | string>>): string =>
  Object.entries(rec)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

export function renderComplianceReport(r: ComplianceReport): string {
  const w = r.window.fromEpoch !== undefined || r.window.toEpoch !== undefined ? `@${r.window.fromEpoch ?? "-∞"}h..@${r.window.toEpoch ?? "+∞"}h` : "all time";
  const lines: string[] = [];
  lines.push(`COMPLIANCE ${w} — ${r.events} event(s) · undated ${r.undated} · dropped ${r.dropped} · ${r.complete ? "complete" : "INCOMPLETE"}`);
  lines.push(`  erasure [${r.erasure.status}]: ${r.erasure.events} event(s), ${r.erasure.cells.length} cell(s)${r.erasure.cells.length > 0 ? ` [${r.erasure.cells.join(", ")}]` : ""}`);
  lines.push(`  cascade [${r.cascade.status}]: ${r.cascade.events} event(s) · forgotten ${r.cascade.forgotten} · refused ${r.cascade.refused} · failed ${r.cascade.failed}`);
  lines.push(`  injection [${r.injection.status}]: ${r.injection.turns} turn(s) · fired ${r.injection.fired} · silent ${r.injection.silent} · budgeted ${r.injection.budgeted} · scoped ${r.injection.scoped} · cells ${r.injection.cells}${Object.keys(r.injection.dropped).length > 0 ? ` · dropped ${kv(r.injection.dropped)}` : ""}`);
  lines.push(`  provenance [${r.provenance.status}]: ${r.provenance.checks} check(s) · ok ${r.provenance.ok} · drifted ${r.provenance.drifted} · absent ${r.provenance.absent} · covered ${r.provenance.covered} · uncovered ${r.provenance.uncovered}`);
  lines.push(`  standing [${r.standing.status}]: ${r.standing.events} event(s) · fresh ${r.standing.fresh} · stale ${r.standing.stale} · unauditable ${r.standing.unauditable}`);
  lines.push(`  outbound [${r.outbound.status}]: ${r.outbound.screened} screened · allowed ${r.outbound.allowed} · refused ${r.outbound.refused}${Object.keys(r.outbound.byPolicy).length > 0 ? ` · ${kv(r.outbound.byPolicy)}` : ""}`);
  lines.push(`  service [${r.service.status}]: ${r.service.verdicts} verdict(s) · within ${r.service.within} · breached ${r.service.breached} · no-verdict ${r.service.noVerdict}${Object.keys(r.service.routes).length > 0 ? ` · ${kv(r.service.routes)}` : ""}`);
  lines.push(`  paging [${r.paging.status}]: ${r.paging.events} move(s) · promotions ${r.paging.promotions} · evictions ${r.paging.evictions} · failed ${r.paging.failed}${Object.keys(r.paging.byReason).length > 0 ? ` · ${kv(r.paging.byReason)}` : ""}`);
  lines.push(`  feed [${r.feed.status}]: ${r.feed.lines} line(s) · consumed ${r.feed.consumed} · complete ${r.feed.complete} · incomplete ${r.feed.incomplete}${r.feed.incomplete > 0 ? ` (by reason ${kv(r.feed.incompleteByReason)}${r.feed.incompleteAttestedLater > 0 ? `; attested later ${r.feed.incompleteAttestedLater}` : ""})` : ""} · malformed ${r.feed.malformed} · foreign ${r.feed.foreign} · live-after-forget ${r.feed.liveAfterForget}${r.feed.consumed > 0 ? ` · max lag ${r.feed.maxLagMs}ms` : ""}${r.feed.consumed > 0 ? ` · by source ${kv(r.feed.bySource)}` : ""} · wiring ${r.feed.wiring}`);
  lines.push(`  reconciliation [${r.reconciliation.status}]: ${r.reconciliation.runs} run(s) · checked ${r.reconciliation.checked} · live ${r.reconciliation.live} · erased ${r.reconciliation.erased} · withheld ${r.reconciliation.withheld} · released ${r.reconciliation.released} · restored ${r.reconciliation.restored} · unverifiable ${r.reconciliation.unverifiable} · deferred ${r.reconciliation.deferred}${Object.keys(r.reconciliation.byMethod).length > 0 ? ` · by method ${kv(r.reconciliation.byMethod)}` : ""}${r.reconciliation.withheldCells.length > 0 ? ` · withheld [${r.reconciliation.withheldCells.join(", ")}]` : ""}`);
  if (r.notes.length > 0) {
    lines.push("  notes:");
    for (const n of r.notes) lines.push(`    ${n}`);
  }
  return lines.join("\n");
}
