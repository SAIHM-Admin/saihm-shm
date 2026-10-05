import type { IndexEntry, RecalledBody } from "../saihm_client/types.js";

export interface ReconcileCandidate {
  readonly cellId: string;
  readonly substrateCellId: string;
  readonly probe?: string;
}

export type ReconcileVerdict = "live" | "erased" | "suspect" | "unverifiable";
export type ReconcileEvidence = "index" | "recall" | "listing" | "none";

export interface ReconcileDecision {
  readonly cellId: string;
  readonly substrateCellId: string;
  readonly verdict: ReconcileVerdict;
  readonly evidence: ReconcileEvidence;
  readonly reason?: string;
  readonly refetch?: boolean;
}

export type ProbeResult =
  | { readonly ok: true; readonly bodies: readonly RecalledBody[]; readonly cap: number; readonly servedBy?: string }
  | { readonly ok: false; readonly reason: string };

export interface ReconcileSummary {
  readonly method: ReconcileEvidence;
  readonly checked: number;
  readonly live: number;
  readonly erased: number;
  readonly suspect: number;
  readonly unverifiable: number;
  readonly deferred: number;
  readonly decisions: readonly ReconcileDecision[];
  readonly notes: readonly string[];
}

export function decideFromIndex(c: ReconcileCandidate, entries: ReadonlyMap<string, IndexEntry>): ReconcileDecision {
  const e = entries.get(c.substrateCellId.toLowerCase());
  const base = { cellId: c.cellId, substrateCellId: c.substrateCellId, evidence: "index" as const };
  if (e === undefined) return { ...base, verdict: "unverifiable", reason: "not listed in the substrate's index — a listing proves presence, never absence" };
  if (e.forgotten) return { ...base, verdict: "erased", reason: "the substrate's index carries forgotten: true" };
  return { ...base, verdict: "live" };
}

export function decideFromProbe(c: ReconcileCandidate, r: ProbeResult | undefined): ReconcileDecision {
  const base = { cellId: c.cellId, substrateCellId: c.substrateCellId, evidence: "recall" as const };
  if (c.probe === undefined || c.probe.trim().length === 0) return { ...base, evidence: "none", verdict: "unverifiable", reason: "no probe: the transport exposes no index and the candidate names no text to recall by" };
  if (r === undefined) return { ...base, evidence: "none", verdict: "unverifiable", reason: "not probed" };
  if (!r.ok) return { ...base, verdict: "unverifiable", reason: `probe failed: ${r.reason}` };
  const want = c.substrateCellId.toLowerCase();
  if (r.bodies.some((b) => b.cellId.toLowerCase() === want)) return { ...base, verdict: "live" };
  if (r.servedBy !== undefined && r.servedBy !== "origin") return { ...base, verdict: "unverifiable", reason: "the probe was answered by a replica: its freshness bounds lag, not omission — absence there is not evidence" };
  if (r.bodies.length >= r.cap) return { ...base, verdict: "unverifiable", reason: `probe result reached the transport's cap (${r.cap}); absence beyond a cap is not evidence` };
  return { ...base, verdict: "suspect", reason: "the substrate returned the probe's matches without this cell and no erasure line was seen: withheld, not erased" };
}

export interface ListingCandidate extends ReconcileCandidate {
  readonly heldSeq?: string;
  readonly heldCommitment?: string;
  readonly writtenAtMs?: number;
}

export interface ListingEvidence {
  readonly complete: boolean;
  readonly startedAtMs: number;
  readonly cells: ReadonlyMap<string, { readonly seq: string | null; readonly commitment?: string }>;
}

const DECIMAL_SEQ = /^\d+$/;

export interface ListingPageInput {
  readonly cells: readonly { readonly cellId: string; readonly seq: string | null; readonly commitment?: string }[];
  readonly next: string | null;
  readonly servedBy?: string;
}

export interface CollectedListing extends ListingEvidence {
  readonly pages: number;
  readonly incompleteReason?: string;
}

export const DEFAULT_LISTING_MAX_PAGES = 1000;

export async function collectListing(
  fetchPage: (after: string | undefined) => Promise<ListingPageInput>,
  opts: { readonly maxPages?: number; readonly now?: () => number } = {},
): Promise<CollectedListing> {
  const maxPages = opts.maxPages ?? DEFAULT_LISTING_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError("collectListing: maxPages must be a positive integer");
  const startedAtMs = (opts.now ?? Date.now)();
  const cells = new Map<string, { readonly seq: string | null; readonly commitment?: string }>();
  const seenNext = new Set<string>();
  let after: string | undefined;
  let pages = 0;
  const partial = (incompleteReason: string): CollectedListing => ({ complete: false, startedAtMs, cells, pages, incompleteReason });
  for (;;) {
    if (pages >= maxPages) return partial(`the page budget (${maxPages}) ran out before the last page`);
    let page: ListingPageInput;
    try {
      page = await fetchPage(after);
    } catch {
      return partial("a page could not be fetched");
    }
    pages++;
    if (page.servedBy !== undefined && page.servedBy !== "origin") return partial("a page was answered by a replica: only the origin's listing may end anything");
    for (const c of page.cells) {
      if (cells.has(c.cellId)) return partial("an id was listed twice: the listing is not consistent");
      cells.set(c.cellId, c.commitment !== undefined ? { seq: c.seq, commitment: c.commitment } : { seq: c.seq });
    }
    if (page.next === null) return { complete: true, startedAtMs, cells, pages };
    if (page.next === after || seenNext.has(page.next)) return partial("`next` did not move forward");
    seenNext.add(page.next);
    after = page.next;
  }
}

export function decideFromListing(c: ListingCandidate, l: ListingEvidence): ReconcileDecision {
  const base = { cellId: c.cellId, substrateCellId: c.substrateCellId, evidence: "listing" as const };
  let listed = l.cells.get(c.substrateCellId);
  if (listed === undefined) {
    const want = c.substrateCellId.toLowerCase();
    for (const [id, v] of l.cells) if (id.toLowerCase() === want) { listed = v; break; }
  }
  if (listed !== undefined) {
    if (c.heldSeq === undefined) return { ...base, verdict: "live" };
    if (listed.seq === null) return { ...base, verdict: "live", refetch: true, reason: "listed without a version: fetch it to verify" };
    const sameSeq = DECIMAL_SEQ.test(c.heldSeq) && DECIMAL_SEQ.test(listed.seq) && BigInt(c.heldSeq) === BigInt(listed.seq);
    const sameCommitment = c.heldCommitment === undefined || listed.commitment === undefined || c.heldCommitment === listed.commitment;
    return sameSeq && sameCommitment ? { ...base, verdict: "live" } : { ...base, verdict: "live", refetch: true, reason: "listed at another version than the one this copy was made from: fetch it again" };
  }
  if (!l.complete) return { ...base, verdict: "unverifiable", reason: "not in a partial listing — only a listing paged to its end proves absence" };
  if (c.writtenAtMs !== undefined && c.writtenAtMs >= l.startedAtMs) {
    return { ...base, verdict: "unverifiable", reason: "confirmed after the listing started: the listing may have passed its id before it existed" };
  }
  return { ...base, verdict: "erased", reason: "absent from a complete listing — erased, recorded incomplete: a listing cannot show how a cell disappeared" };
}

export function summarize(method: ReconcileEvidence, decisions: readonly ReconcileDecision[], deferred: number, extraNotes: readonly string[] = []): ReconcileSummary {
  let live = 0, erased = 0, suspect = 0, unverifiable = 0;
  for (const d of decisions) {
    if (d.verdict === "live") live++;
    else if (d.verdict === "erased") erased++;
    else if (d.verdict === "suspect") suspect++;
    else unverifiable++;
  }
  const notes: string[] = [];
  if (decisions.length === 0 && deferred === 0) notes.push("no candidates: nothing could have been reconciled — this run is vacuous, not clean");
  if (erased > 0) {
    notes.push(method === "listing"
      ? `${erased} copied row(s) ERASED: absent from a complete version listing (no erasure line seen): purged here, recorded incomplete`
      : `${erased} copied row(s) ERASED on the substrate's index (forgotten there, no erasure line seen): purged here`);
  }
  const refetch = decisions.filter((d) => d.refetch === true).length;
  if (refetch > 0) notes.push(`${refetch} copied row(s) live at a NEWER version: fetched again`);
  if (suspect > 0) notes.push(`${suspect} copied row(s) WITHHELD: the substrate no longer returns them for their own text and no erasure line was seen — served again when a later run finds them`);
  if (unverifiable > 0) notes.push(`${unverifiable} candidate(s) UNVERIFIABLE (not listed, a partial listing, written during the listing, capped or failed probe, or no probe): unchanged, still served`);
  if (deferred > 0) notes.push(`${deferred} candidate(s) DEFERRED by the per-run probe budget: unchanged, still served`);
  for (const n of extraNotes) notes.push(n);
  return { method, checked: decisions.length, live, erased, suspect, unverifiable, deferred, decisions, notes };
}
