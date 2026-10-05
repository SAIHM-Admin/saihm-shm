import { dirname, join } from "node:path";
import { FEED_MAX_LINE_BYTES, HEX64, ISO_UTC, resolveFeedPath, type ResolveFeedPathInput } from "./feed_watcher.js";

export const CHANGES_VERSION = 1 as const;
export const CHANGES_FILENAME = "changes.ndjson";

const DECIMAL = /^\d+$/;

export interface CellWrittenLine {
  readonly v: 1;
  readonly kind: "cell-written";
  readonly cellId: string;
  readonly agentIdHash: string;
  readonly at: string;
  readonly atMs: number;
  readonly seq: string;
  readonly commitment: string;
  readonly source: string;
}

export interface ChangesMarkerLine {
  readonly v: 1;
  readonly kind: "position" | "gap";
  readonly agentIdHash: string;
  readonly at: string;
  readonly atMs: number;
  readonly cursor: string;
  readonly reason?: string;
}

export type ChangesLine = CellWrittenLine | ChangesMarkerLine;

const GAP_REASON = /^[a-z][a-z-]{0,63}$/;

export type ChangesFaultOutcome = "malformed" | "foreign" | "ignored";

export type ChangesLineVerdict =
  | { readonly ok: true; readonly line: ChangesLine }
  | { readonly ok: false; readonly outcome: ChangesFaultOutcome; readonly reason: string };

export function parseChangesLine(raw: string, expectIdentity?: string): ChangesLineVerdict {
  const bad = (reason: string): ChangesLineVerdict => ({ ok: false, outcome: "malformed", reason });
  if (Buffer.byteLength(raw, "utf8") > FEED_MAX_LINE_BYTES) return bad(`line exceeds ${FEED_MAX_LINE_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bad("not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return bad("not a JSON object");
  const r = parsed as Record<string, unknown>;
  if (r["v"] !== CHANGES_VERSION) return bad(`v is not ${CHANGES_VERSION}`);
  const kindRaw = r["kind"];
  if (typeof kindRaw !== "string" || kindRaw === "") return bad("kind missing or empty");
  const kind = kindRaw === "written" ? "cell-written" : kindRaw;
  const agentIdHash = r["agentIdHash"];
  if (typeof agentIdHash !== "string" || !HEX64.test(agentIdHash)) return bad("agentIdHash is not a 64-hex hash");
  const at = r["at"];
  if (typeof at !== "string" || !ISO_UTC.test(at)) return bad("at is not an ISO-8601 UTC timestamp ending in Z");
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return bad("at does not parse as a date");
  if (expectIdentity !== undefined && agentIdHash !== expectIdentity) {
    return { ok: false, outcome: "foreign", reason: "the line carries another identity's agentIdHash — a foreign line in a per-identity feed is a wiring fault" };
  }
  if (kind !== "cell-written" && kind !== "position" && kind !== "gap") {
    return { ok: false, outcome: "ignored", reason: "a kind this reader does not know: skipped and counted, never applied" };
  }
  if (kind === "cell-written") {
    const cellId = r["cellId"];
    if (typeof cellId !== "string" || cellId === "") return bad("cellId missing or empty");
    const seq = r["seq"];
    if (typeof seq !== "string" || !DECIMAL.test(seq)) return bad("seq is not a decimal string");
    const commitment = r["commitment"];
    if (typeof commitment !== "string" || !HEX64.test(commitment)) return bad("commitment is not a 64-hex hash");
    const source = r["source"];
    if (typeof source !== "string" || source === "") return bad("source missing or empty");
    return { ok: true, line: { v: 1, kind, cellId, agentIdHash, at, atMs, seq, commitment, source } };
  }
  const cursor = r["cursor"];
  if (typeof cursor !== "string" || cursor === "") return bad("cursor missing or empty");
  const reason = r["reason"];
  if (kind === "gap" && typeof reason === "string" && GAP_REASON.test(reason)) {
    return { ok: true, line: { v: 1, kind, agentIdHash, at, atMs, cursor, reason } };
  }
  return { ok: true, line: { v: 1, kind, agentIdHash, at, atMs, cursor } };
}

export function resolveChangesPath(i: ResolveFeedPathInput): string {
  return join(dirname(resolveFeedPath(i)), CHANGES_FILENAME);
}

export function compareSeq(a: string, b: string): number {
  const x = BigInt(a), y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export interface FeedPoint {
  readonly ino: number;
  readonly bytes: number;
}

export interface OwedRefetch {
  readonly cellId: string;
  readonly seq: string;
  readonly commitment: string;
}

export interface ReconcileTicket {
  readonly through: number;
}

export interface ChangesOwed {
  readonly refetch: readonly OwedRefetch[];
  readonly reconcile: ReconcileTicket | null;
}

export interface ChangesTrackerStatus {
  readonly linesObserved: number;
  readonly markersPending: number;
  readonly escalatedToGap: number;
  readonly unreadable: number;
  readonly appliedCursor: string | null;
}

interface PendingWrite {
  seq: string;
  commitment: string;
  order: number;
}

interface PendingMarker {
  kind: "position" | "gap";
  readonly cursor: string | null;
  readonly order: number;
  readonly feedAt: FeedPoint | null;
  readonly readerInoAtMarker: number | null;
  seenFeedIno: boolean;
  confirmed: boolean;
  reconciled: boolean;
}

export class ChangesTracker {
  private order = 0;
  private readonly writes = new Map<string, PendingWrite>();
  private markers: PendingMarker[] = [];
  private consumed: FeedPoint | null = null;
  private applied: string | null = null;
  private escalated = 0;
  private unreadableLines = 0;
  private readonly issued = new WeakSet<ReconcileTicket>();

  observe(line: ChangesLine, feedNow: FeedPoint | null): void {
    const order = ++this.order;
    if (line.kind === "cell-written") {
      const cur = this.writes.get(line.cellId);
      if (cur !== undefined && compareSeq(cur.seq, line.seq) >= 0) return;
      this.writes.set(line.cellId, { seq: line.seq, commitment: line.commitment, order });
      return;
    }
    const m: PendingMarker = {
      kind: line.kind,
      cursor: line.cursor,
      order,
      feedAt: line.kind === "position" ? feedNow : null,
      readerInoAtMarker: this.consumed?.ino ?? null,
      seenFeedIno: false,
      confirmed: false,
      reconciled: false,
    };
    if (m.kind === "position") {
      if (feedNow === null) {
        if (this.consumed === null) m.confirmed = true;
        else this.escalate(m);
      } else if (this.consumed !== null) {
        this.track(m, this.consumed);
      }
    }
    this.markers.push(m);
    this.advance();
  }

  observeUnreadable(): void {
    const order = ++this.order;
    this.unreadableLines++;
    this.markers.push({ kind: "gap", cursor: null, order, feedAt: null, readerInoAtMarker: null, seenFeedIno: false, confirmed: false, reconciled: false });
    this.advance();
  }

  appliedWrite(cellId: string, seq: string): void {
    const cur = this.writes.get(cellId);
    if (cur !== undefined && compareSeq(seq, cur.seq) >= 0) this.writes.delete(cellId);
    this.advance();
  }

  erased(cellId: string): void {
    this.writes.delete(cellId);
    this.advance();
  }

  erasureFeedConsumed(point: FeedPoint): void {
    this.consumed = point;
    for (const m of this.markers) if (m.kind === "position" && !m.confirmed) this.track(m, point);
    this.advance();
  }

  reconciled(ticket: ReconcileTicket): void {
    if (!this.issued.has(ticket)) return;
    for (const m of this.markers) if (m.kind === "gap" && m.order <= ticket.through) m.reconciled = true;
    for (const [id, w] of this.writes) if (w.order < ticket.through) this.writes.delete(id);
    this.advance();
  }

  owed(): ChangesOwed {
    const refetch = [...this.writes.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .map(([cellId, w]) => ({ cellId, seq: w.seq, commitment: w.commitment }));
    let through = -1;
    for (const m of this.markers) if (m.kind === "gap" && !m.reconciled) through = m.order;
    let reconcile: ReconcileTicket | null = null;
    if (through >= 0) {
      reconcile = Object.freeze({ through });
      this.issued.add(reconcile);
    }
    return { refetch, reconcile };
  }

  appliedCursor(): string | null {
    return this.applied;
  }

  status(): ChangesTrackerStatus {
    return { linesObserved: this.order, markersPending: this.markers.length, escalatedToGap: this.escalated, unreadable: this.unreadableLines, appliedCursor: this.applied };
  }

  private track(m: PendingMarker, point: FeedPoint): void {
    const feed = m.feedAt!;
    if (point.ino === feed.ino) {
      m.seenFeedIno = true;
      if (point.bytes >= feed.bytes) m.confirmed = true;
      return;
    }
    if (m.seenFeedIno || point.ino !== m.readerInoAtMarker) this.escalate(m);
  }

  private escalate(m: PendingMarker): void {
    m.kind = "gap";
    this.escalated++;
  }

  private advance(): void {
    let lastOk = -1;
    for (let i = 0; i < this.markers.length; i++) {
      if (!this.holds(this.markers[i]!)) break;
      lastOk = i;
    }
    if (lastOk < 0) return;
    for (let i = lastOk; i >= 0; i--) {
      const c = this.markers[i]!.cursor;
      if (c !== null) {
        this.applied = c;
        break;
      }
    }
    this.markers = this.markers.slice(lastOk + 1);
  }

  private holds(m: PendingMarker): boolean {
    for (const w of this.writes.values()) if (w.order < m.order) return false;
    return m.kind === "gap" ? m.reconciled : m.confirmed;
  }
}

export interface HeldVersion {
  readonly seq: string;
  readonly commitment?: string;
}

export function heldCovers(line: { readonly seq: string; readonly commitment: string }, held: HeldVersion | undefined): boolean {
  if (held === undefined || !DECIMAL.test(held.seq) || !DECIMAL.test(line.seq)) return false;
  const c = compareSeq(held.seq, line.seq);
  if (c > 0) return true;
  return c === 0 && held.commitment !== undefined && held.commitment === line.commitment;
}

export type RefetchResult =
  | { readonly found: true; readonly seq: string }
  | { readonly found: false }
  | { readonly failed: true };

export type RefetchOutcome =
  | { readonly kind: "applied"; readonly seq: string }
  | { readonly kind: "erased" }
  | { readonly kind: "retry"; readonly reason: string };

export function decideRefetch(line: { readonly seq: string }, fetched: RefetchResult, erasureLineSeen: boolean): RefetchOutcome {
  if ("failed" in fetched) return { kind: "retry", reason: "the fetch failed" };
  if (!fetched.found) {
    return erasureLineSeen ? { kind: "erased" } : { kind: "retry", reason: "not served and no erasure line names it: unavailable, not erased" };
  }
  if (!DECIMAL.test(fetched.seq) || !DECIMAL.test(line.seq)) return { kind: "retry", reason: "the fetched version carries no readable seq" };
  if (compareSeq(fetched.seq, line.seq) < 0) return { kind: "retry", reason: "an older version than announced: a lagging copy, never applied" };
  return { kind: "applied", seq: fetched.seq };
}

export interface FeedHeartbeat {
  readonly asOfMs: number | null;
  readonly stopped: string | null;
}

export const DEFAULT_FEED_LIVENESS_MS = 60_000;

const FUTURE_SLACK_MS = 1_000;

export type FeedLiveness =
  | { readonly live: true; readonly ageMs: number }
  | { readonly live: false; readonly why: "no-writer" | "unreadable" | "stopped" | "no-answer-yet" | "stale" | "clock"; readonly detail: string };

export function feedLiveness(heartbeat: FeedHeartbeat | "absent" | "unreadable", nowMs: number, maxAgeMs: number = DEFAULT_FEED_LIVENESS_MS): FeedLiveness {
  if (!Number.isFinite(nowMs)) throw new RangeError("feedLiveness: nowMs must be a finite number of milliseconds");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new RangeError("feedLiveness: maxAgeMs must be a positive finite number of milliseconds");
  if (heartbeat === "absent") return { live: false, why: "no-writer", detail: "no share-states.json: no writer is running" };
  if (heartbeat === "unreadable") return { live: false, why: "unreadable", detail: "share-states.json could not be read" };
  if (heartbeat.stopped !== null) return { live: false, why: "stopped", detail: "the writer says it stopped following the feed" };
  if (heartbeat.asOfMs === null || !Number.isFinite(heartbeat.asOfMs)) return { live: false, why: "no-answer-yet", detail: "the writer has no answer from the service yet" };
  const ageMs = nowMs - heartbeat.asOfMs;
  if (ageMs < -FUTURE_SLACK_MS) return { live: false, why: "clock", detail: "the heartbeat is later than this clock: it proves nothing" };
  if (ageMs > maxAgeMs) return { live: false, why: "stale", detail: `no answer from the service for more than ${maxAgeMs} ms` };
  return { live: true, ageMs: Math.max(0, ageMs) };
}
