import { gateScope, type GateScope } from "../gate/scope.js";
import { refKey, sharerMatches } from "./inbound.js";
import { displayUntrusted } from "./untrusted_text.js";

export type ShareStatus = "live" | "stale" | "ended" | "erased" | "unknown";
export type EndedBy = "event" | "reconciliation" | "unknown";

export const EVENT_ENDS_MAY_HIDE_ERASURES = true;

function endedMayHideErasure(e: ShareStateEntry): boolean {
  return e.endedBy !== "event" || EVENT_ENDS_MAY_HIDE_ERASURES;
}

function endedWhy(e: ShareStateEntry, firstSeen: boolean): string {
  const lead = firstSeen ? "first seen already ended" : "ended";
  if (e.endedBy !== "event") return `${lead} by reconciliation — possibly erased`;
  return endedMayHideErasure(e)
    ? `${lead} by an event (revoked or expired) — possibly erased: an expiry can hide an erasure that was never delivered`
    : `${lead} by an event (revoked or expired)`;
}

export interface ShareStateEntry {
  readonly key: string;
  readonly sharer: string;
  readonly cellId: string;
  readonly status: ShareStatus;
  readonly statusText: string;
  readonly grant: string | null;
  readonly scope: string | null;
  readonly expiryEpoch: string | null;
  readonly seq: string | null;
  readonly commitment: string | null;
  readonly senderVerified: boolean;
  readonly endedAt: number | null;
  readonly endedBy: EndedBy | null;
  readonly copiesInvalidBefore: number | null | "unreadable";
}

export interface ShareStateMap {
  readonly since: number | null;
  readonly complete: boolean;
  readonly entries: readonly ShareStateEntry[];
  readonly defects: readonly string[];
  readonly summary?: ShareStateSummary;
}

export type FeedStopped = "unsupported" | "tier" | "erased" | "unknown";

export interface ShareCounts {
  readonly live: number | null;
  readonly stale: number | null;
  readonly ended: number | null;
  readonly erased: number | null;
}

export interface ShareStateSummary {
  readonly since: number | null;
  readonly complete: boolean;
  readonly asOf: number | null;
  readonly stopped: FeedStopped | null;
  readonly stoppedText: string | null;
  readonly startedAt: number | null;
  readonly counts: ShareCounts;
  readonly defects: readonly string[];
}

export type ShareStatesRead =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed"; readonly why: string }
  | { readonly kind: "summary"; readonly summary: ShareStateSummary }
  | { readonly kind: "present"; readonly map: ShareStateMap };

const STATUSES: ReadonlySet<string> = new Set(["live", "stale", "ended", "erased"]);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function timeOf(v: unknown): number | null | "unreadable" {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !ISO_UTC.test(v)) return "unreadable";
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return "unreadable";
  return new Date(t).toISOString().slice(0, 19) === v.slice(0, 19) ? t : "unreadable";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const lc = (s: string | null): string | null => (s === null ? null : s.toLowerCase());

function obligation(e: ShareStateEntry): number {
  if (e.status === "erased") return 5;
  if (e.copiesInvalidBefore !== null) return 4;
  if (e.status === "ended") return 3;
  if (e.status === "stale") return 2;
  if (e.status === "unknown") return 1;
  return 0;
}

export function readShareStates(recallResult: unknown): ShareStatesRead {
  if (!isObject(recallResult)) return { kind: "malformed", why: "the recall result is not an object" };
  if (!Object.prototype.hasOwnProperty.call(recallResult, "shareStates")) return { kind: "absent" };
  const raw = recallResult["shareStates"];
  if (!isObject(raw)) return { kind: "malformed", why: "shareStates is not an object" };
  if (!Object.prototype.hasOwnProperty.call(raw, "entries")) {
    if (!isObject(raw["counts"])) return { kind: "malformed", why: "shareStates carries neither entries nor counts" };
    return { kind: "summary", summary: readSummary(raw) };
  }
  if (!Array.isArray(raw["entries"])) return { kind: "malformed", why: "shareStates.entries is not an array" };
  return { kind: "present", map: readMap(raw) };
}

function readSummary(raw: Record<string, unknown>): ShareStateSummary {
  const defects: string[] = [];
  const time = (field: string): number | null => {
    const v = timeOf(raw[field]);
    if (v === "unreadable") {
      defects.push(`${field} is unreadable — read as null`);
      return null;
    }
    return v;
  };
  const since = time("since");
  const statedComplete = raw["complete"];
  if (typeof statedComplete !== "boolean") defects.push("complete is not a boolean — read as false");
  const asOf = time("asOf");
  const startedAt = time("startedAt");
  const stoppedRaw = raw["stopped"];
  let stopped: FeedStopped | null = null;
  let stoppedText: string | null = null;
  if (stoppedRaw !== null && stoppedRaw !== undefined) {
    if (stoppedRaw === "unsupported" || stoppedRaw === "tier" || stoppedRaw === "erased") {
      stopped = stoppedRaw;
    } else {
      stopped = "unknown";
      stoppedText = displayUntrusted(typeof stoppedRaw === "string" ? stoppedRaw : String(stoppedRaw), 32);
      defects.push(`stopped "${stoppedText}" is not a v1 reason — kept as unknown`);
    }
  }
  const countsRaw = isObject(raw["counts"]) ? raw["counts"] : {};
  const count = (field: keyof ShareCounts): number | null => {
    const v = countsRaw[field];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
    defects.push(`counts.${field} is not a whole number — read as null`);
    return null;
  };
  const counts: ShareCounts = { live: count("live"), stale: count("stale"), ended: count("ended"), erased: count("erased") };
  return { since, complete: statedComplete === true, asOf, stopped, stoppedText, startedAt, counts, defects };
}

function readMap(raw: Record<string, unknown>): ShareStateMap {
  const defects: string[] = [];
  let lossless = true;

  const sinceT = timeOf(raw["since"]);
  if (sinceT === "unreadable") defects.push("since is unreadable — read as null, so a missing key concludes nothing");
  const since = sinceT === "unreadable" ? null : sinceT;

  const statedComplete = raw["complete"];
  if (typeof statedComplete !== "boolean") {
    defects.push("complete is not a boolean — read as false");
    lossless = false;
  }

  const byKey = new Map<string, ShareStateEntry>();
  (raw["entries"] as unknown[]).forEach((r, i) => {
    if (!isObject(r)) {
      defects.push(`entry ${i} is not an object — dropped, so the map is incomplete here`);
      lossless = false;
      return;
    }
    const sharer = r["sharer"];
    const cellId = r["cellId"];
    if (typeof sharer !== "string" || typeof cellId !== "string") {
      defects.push(`entry ${i} lacks a string sharer or cellId — dropped, so the map is incomplete here`);
      lossless = false;
      return;
    }
    const statusText = typeof r["status"] === "string" ? r["status"] : String(r["status"]);
    const status: ShareStatus = STATUSES.has(statusText) ? (statusText as ShareStatus) : "unknown";
    if (status === "unknown") {
      defects.push(`entry ${i}: status "${displayUntrusted(statusText, 32)}" is not a v1 status — kept as unknown, never as live`);
    }
    const text = (field: string): string | null => {
      const v = r[field];
      if (v === null || v === undefined) return null;
      if (typeof v === "string") return v;
      defects.push(`entry ${i}: ${field} is not a string — set aside`);
      return null;
    };
    const endedByRaw = r["endedBy"];
    const endedBy: EndedBy | null =
      endedByRaw === null || endedByRaw === undefined
        ? null
        : endedByRaw === "event" || endedByRaw === "reconciliation"
          ? endedByRaw
          : "unknown";
    const endedAt = timeOf(r["endedAt"]);
    if (endedAt === "unreadable") defects.push(`entry ${i}: endedAt is unreadable — set aside`);
    const cib = timeOf(r["copiesInvalidBefore"]);
    if (cib === "unreadable") defects.push(`entry ${i}: copiesInvalidBefore is unreadable — every copy of this cell is treated as invalid`);

    const entry: ShareStateEntry = {
      key: refKey({ sharer, cellId }),
      sharer: sharer.trim().toLowerCase(),
      cellId,
      status,
      statusText,
      grant: text("grant"),
      scope: text("scope"),
      expiryEpoch: text("expiryEpoch"),
      seq: text("seq"),
      commitment: text("commitment"),
      senderVerified: r["senderVerified"] === true,
      endedAt: endedAt === "unreadable" ? null : endedAt,
      endedBy,
      copiesInvalidBefore: cib,
    };
    const held = byKey.get(entry.key);
    if (held !== undefined) {
      defects.push(`two entries share the key "${displayUntrusted(entry.key)}" — kept the one that obliges more`);
      lossless = false;
      if (obligation(entry) > obligation(held)) byKey.set(entry.key, entry);
      return;
    }
    byKey.set(entry.key, entry);
  });

  const entries = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const summary = isObject(raw["counts"]) ? readSummary(raw) : undefined;
  return {
    since,
    complete: statedComplete === true && lossless,
    entries,
    defects: summary === undefined ? defects : [...defects, ...summary.defects.map((d) => `header: ${d}`)],
    ...(summary !== undefined ? { summary } : {}),
  };
}

export function readShareStatesFile(text: string): ShareStatesRead {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { kind: "malformed", why: "the share-states file is not JSON" };
  }
  if (!isObject(doc)) return { kind: "malformed", why: "the share-states file is not an object" };
  if (doc["v"] !== 1) return { kind: "malformed", why: `unsupported share-states file version ${displayUntrusted(String(doc["v"]), 16)}` };
  if (!Array.isArray(doc["entries"])) return { kind: "malformed", why: "the share-states file carries no entries array" };
  return { kind: "present", map: readMap(doc) };
}

export function countsOf(map: ShareStateMap): { readonly live: number; readonly stale: number; readonly ended: number; readonly erased: number } {
  let live = 0, stale = 0, ended = 0, erased = 0;
  for (const e of map.entries) {
    if (e.status === "live") live += 1;
    else if (e.status === "stale") stale += 1;
    else if (e.status === "ended") ended += 1;
    else if (e.status === "erased") erased += 1;
  }
  return { live, stale, ended, erased };
}

const countsText = (c: ShareCounts): string =>
  `live ${c.live ?? "?"}, stale ${c.stale ?? "?"}, ended ${c.ended ?? "?"}, erased ${c.erased ?? "?"}`;
const isoOrNull = (t: number | null): string => (t === null ? "null" : new Date(t).toISOString());

export interface FileCurrency {
  readonly usable: boolean;
  readonly why: string;
}

export function fileCurrency(summary: ShareStateSummary, file: ShareStatesRead): FileCurrency {
  if (file.kind !== "present") {
    return { usable: false, why: file.kind === "malformed" ? `the share-states file is unreadable (${file.why})` : "no share-states file was read" };
  }
  const fs = file.map.summary;
  if (fs === undefined) return { usable: false, why: "the share-states file carries no header — it cannot be placed against the recall's summary" };
  if (summary.startedAt === null) return { usable: false, why: "the recall's feed has not started — it names no process the file could belong to" };
  if (fs.startedAt !== summary.startedAt) return { usable: false, why: "the share-states file is another process's map (a different startedAt)" };
  if (summary.asOf === null) {
    return { usable: true, why: fs.asOf === null ? "the same process, before its first answer on both" : "the same process, and the file already holds an answer the recall's summary did not" };
  }
  if (fs.asOf === null) return { usable: false, why: "the share-states file has no asOf — it cannot be placed against the recall's summary" };
  if (fs.asOf < summary.asOf) return { usable: false, why: `the share-states file lags the recall's summary by ${summary.asOf - fs.asOf} ms — a past map` };
  return {
    usable: true,
    why: fs.asOf === summary.asOf
      ? "the share-states file is the recall's map (the same process, the same asOf)"
      : `the share-states file is newer than the recall's summary by ${fs.asOf - summary.asOf} ms`,
  };
}

export interface SummaryFindings {
  readonly lines: readonly string[];
  readonly entriesNeeded: boolean;
}

export function summaryFindings(s: ShareStateSummary, baseline: ShareStateMap | null): SummaryFindings {
  const lines: string[] = [];
  let entriesNeeded = false;
  if (s.stopped !== null) {
    const reason = s.stopped === "unknown" ? `an unknown reason "${s.stoppedText ?? ""}"` : s.stopped;
    lines.push(`the client's feed is stopped (${reason}) — the map is not being followed; versions and erasures after it stopped are not visible`);
  } else if (s.asOf === null) {
    lines.push(`the feed is starting — no answer yet from the endpoint (started ${isoOrNull(s.startedAt)}); the map holds nothing to conclude from`);
  }
  if (!s.complete) lines.push(`the map is not complete${s.since === null ? " and not reconciled" : ""} — a missing key concludes nothing`);
  const c = s.counts;
  const fields = ["live", "stale", "ended", "erased"] as const;
  const unreadable = fields.filter((k) => c[k] === null);
  if (unreadable.length > 0) {
    entriesNeeded = true;
    lines.push(`counts unreadable for ${unreadable.join(", ")} — the entries must be read`);
  }
  if ((c.erased ?? 0) > 0) {
    entriesNeeded = true;
    lines.push(`${c.erased} erased entr${c.erased === 1 ? "y" : "ies"} — unnamed: fetch the entries to learn which cells' copies to delete`);
  }
  if ((c.ended ?? 0) > 0) {
    entriesNeeded = true;
    lines.push(`${c.ended} ended — which ended by reconciliation (possibly erased) is unknown without the entries`);
  }
  if ((c.stale ?? 0) > 0) {
    entriesNeeded = true;
    lines.push(`${c.stale} stale — a newer version this grant cannot open; which is unknown without the entries`);
  }
  if (baseline === null) {
    lines.push(`no kept baseline — counts ${countsText(c)} as of ${isoOrNull(s.asOf)}; the first entries read become the baseline`);
  } else {
    const b = countsOf(baseline);
    const moved = fields.filter((k) => c[k] !== null && c[k] !== b[k]).map((k) => `${k} ${b[k]} → ${c[k]}`);
    if (moved.length > 0) {
      entriesNeeded = true;
      lines.push(`the map changed since the kept baseline (${moved.join(", ")}) — fetch the entries`);
    } else {
      lines.push(`counts equal the kept baseline's (${countsText(c)}) — a re-share or a newer version would not show in counts; not a clean bill`);
    }
  }
  return { lines, entriesNeeded };
}

export function mapIsWhole(map: ShareStateMap): boolean {
  return map.since !== null && map.complete;
}

export function entryFor(map: ShareStateMap, sharer: string, cellId: string): ShareStateEntry | undefined {
  const key = refKey({ sharer, cellId });
  return map.entries.find((e) => e.key === key);
}

export const COPY_SKEW_MS = 5 * 60_000;

export type CopyStanding = "erased" | "possibly-erased" | "ended" | "stale" | "superseded" | "current" | "undetermined";

export interface HeldCopy {
  readonly madeAt: number;
  readonly grant?: string;
  readonly commitment?: string;
  readonly seq?: string;
}

export interface CopyVerdict {
  readonly standing: CopyStanding;
  readonly why: string;
}

export function copyStanding(read: ShareStatesRead, sharer: string, cellId: string, copy: HeldCopy): CopyVerdict {
  if (read.kind === "absent") {
    return { standing: "undetermined", why: "no share map — the client does not run the feed, so versions and erasures cannot be seen" };
  }
  if (read.kind === "malformed") return { standing: "undetermined", why: `the share map is malformed (${read.why})` };
  if (read.kind === "summary") {
    return { standing: "undetermined", why: "the recall carried the map's summary only — no entries to place the copy against; read the entries" };
  }
  const map = read.map;
  const e = entryFor(map, sharer, cellId);

  if (e !== undefined) {
    if (e.status === "erased") return { standing: "erased", why: "the entry is erased — delete the copy" };
    if (e.copiesInvalidBefore === "unreadable") {
      return { standing: "erased", why: "copiesInvalidBefore is present but unreadable — every copy is treated as invalid" };
    }
    if (e.copiesInvalidBefore !== null && !(Number.isFinite(copy.madeAt) && copy.madeAt > e.copiesInvalidBefore + COPY_SKEW_MS)) {
      return { standing: "erased", why: "the copy was made before copiesInvalidBefore (the 5-minute skew allowance included) — delete it" };
    }
  }

  if (e === undefined) {
    if (mapIsWhole(map)) {
      return { standing: "possibly-erased", why: "the key is missing from a whole map — its share ended before the map began, or its tombstone aged out" };
    }
    return {
      standing: "undetermined",
      why: map.since === null
        ? "the key is missing, and the map has not been reconciled (since is null) — no conclusion"
        : "the key is missing from an incomplete map — no conclusion",
    };
  }

  if (e.status === "ended") {
    if (!endedMayHideErasure(e)) {
      return { standing: "ended", why: "revoked or expired by an event — a read already taken stands; no newer version can be fetched" };
    }
    return e.endedBy === "event"
      ? { standing: "possibly-erased", why: "ended by an event, which cannot tell an expiry from a revocation — and an expiry can hide an erasure that was never delivered" }
      : { standing: "possibly-erased", why: "ended by reconciliation, which cannot tell an erasure from a revocation" };
  }
  if (e.status === "stale") {
    return { standing: "stale", why: "a newer version exists that this grant cannot open — keep the copy, do not fetch, wait for the grant to be wrapped again" };
  }
  if (e.status === "unknown") {
    return { standing: "undetermined", why: `status "${displayUntrusted(e.statusText, 32)}" is not a v1 status` };
  }

  if (copy.grant !== undefined && e.grant !== null && copy.grant.toLowerCase() !== e.grant.toLowerCase()) {
    return { standing: "superseded", why: "the copy was read under another grant — shared again since; read it again" };
  }
  const commitmentBoth = copy.commitment !== undefined && e.commitment !== null;
  const seqBoth = copy.seq !== undefined && e.seq !== null;
  if (commitmentBoth && copy.commitment!.toLowerCase() !== e.commitment!.toLowerCase()) {
    return { standing: "superseded", why: "the entry's commitment differs from the copy's — a newer version exists; read it again" };
  }
  if (!commitmentBoth && seqBoth && copy.seq !== e.seq) {
    return { standing: "superseded", why: "the entry's write sequence differs from the copy's — read it again" };
  }
  if ((copy.commitment !== undefined || copy.seq !== undefined) && !commitmentBoth && !seqBoth) {
    return { standing: "undetermined", why: "the copy's version was recorded, but the entry states none to compare it with (learned from an event, not yet reconciled) — whether the copy is current cannot be seen" };
  }
  if (copy.grant !== undefined && e.grant === null && !commitmentBoth) {
    return { standing: "undetermined", why: "the copy's grant was recorded, but the entry states none — whether the cell was shared again cannot be seen, and no commitment settles it" };
  }
  return mapIsWhole(map)
    ? { standing: "current", why: "live in a whole map, and nothing recorded about the copy disagrees with the entry" }
    : { standing: "undetermined", why: "live, but the map is incomplete or not reconciled — the entry may be out of date" };
}

export type ShareObligationKind = "erased" | "copies-invalid" | "possibly-erased" | "stale";

export interface ShareObligation {
  readonly kind: ShareObligationKind;
  readonly entry: ShareStateEntry;
  readonly why: string;
}

export function shareObligations(read: ShareStatesRead): readonly ShareObligation[] {
  if (read.kind !== "present") return [];
  const out: ShareObligation[] = [];
  for (const e of read.map.entries) {
    if (e.status === "erased") {
      out.push({ kind: "erased", entry: e, why: "erased — delete cached copies of the cell" });
    } else if (e.copiesInvalidBefore !== null) {
      out.push({
        kind: "copies-invalid",
        entry: e,
        why: e.copiesInvalidBefore === "unreadable"
          ? "copiesInvalidBefore is unreadable — every copy of the cell is invalid"
          : `copies made before ${new Date(e.copiesInvalidBefore).toISOString()} (plus 5 minutes) are invalid — delete them`,
      });
    } else if (e.status === "ended" && endedMayHideErasure(e)) {
      out.push({ kind: "possibly-erased", entry: e, why: `${endedWhy(e, false)}; review cached copies` });
    } else if (e.status === "stale") {
      out.push({ kind: "stale", entry: e, why: "stale — do not fetch; the grant cannot open the newest version" });
    }
  }
  return out;
}

export function obligationKey(o: ShareObligation): string {
  const e = o.entry;
  const cib = e.copiesInvalidBefore === null || e.copiesInvalidBefore === "unreadable"
    ? e.copiesInvalidBefore
    : new Date(e.copiesInvalidBefore).toISOString();
  return JSON.stringify(["obligation", o.kind, e.key, lc(e.grant), e.commitment !== null ? lc(e.commitment) : e.seq, cib]);
}

export function pendingObligations(read: ShareStatesRead, seen: ReadonlySet<string>): readonly ShareObligation[] {
  return shareObligations(read).filter((o) => !seen.has(obligationKey(o)));
}

export type ShareTransitionKind =
  | "new"
  | "updated"
  | "reshared"
  | "stale"
  | "ended"
  | "erased"
  | "copies-invalidated"
  | "vanished"
  | "undetermined";

export interface ShareTransition {
  readonly kind: ShareTransitionKind;
  readonly key: string;
  readonly sharer: string;
  readonly cellId: string;
  readonly before: ShareStateEntry | null;
  readonly after: ShareStateEntry | null;
  readonly why: string;
}

export type ShareBaseline = "first" | "continuous" | "restarted" | "unreconciled" | "unusable";

export interface ShareTransitionReport {
  readonly baseline: ShareBaseline;
  readonly transitions: readonly ShareTransition[];
  readonly scope: GateScope;
  readonly verdict: string;
}

type VersionMove = "moved" | "unmoved" | "incomparable";

const sameStatedGrant = (p: ShareStateEntry, c: ShareStateEntry): boolean =>
  p.grant !== null && c.grant !== null && lc(p.grant) === lc(c.grant);

function versionMove(p: ShareStateEntry, c: ShareStateEntry): VersionMove {
  const seqBoth = p.seq !== null && c.seq !== null;
  const commitmentBoth = p.commitment !== null && c.commitment !== null;
  if ((seqBoth && p.seq !== c.seq) || (commitmentBoth && lc(p.commitment) !== lc(c.commitment))) return "moved";
  if (commitmentBoth) return "unmoved";
  if (seqBoth) return sameStatedGrant(p, c) ? "unmoved" : "incomparable";
  const stated = (e: ShareStateEntry): boolean => e.seq !== null || e.commitment !== null;
  return stated(p) || stated(c) ? "incomparable" : "unmoved";
}

const singleWriteUnderOneGrant = (p: ShareStateEntry, c: ShareStateEntry): boolean => sameStatedGrant(p, c) && c.seq === "1";

const sameCib = (a: ShareStateEntry["copiesInvalidBefore"], b: ShareStateEntry["copiesInvalidBefore"]): boolean => a === b;

function transitionsOfPair(p: ShareStateEntry, c: ShareStateEntry): ShareTransition[] {
  const out: ShareTransition[] = [];
  const add = (kind: ShareTransitionKind, why: string): void => {
    out.push({ kind, key: c.key, sharer: c.sharer, cellId: c.cellId, before: p, after: c, why });
  };
  const readable = (s: ShareStatus): boolean => s === "live" || s === "stale";

  if (c.status === "erased" && p.status !== "erased") {
    add("erased", "erased — delete cached copies of the cell");
  } else if (c.status === "ended" && readable(p.status)) {
    add("ended", endedWhy(c, false));
  } else if (readable(c.status) && (p.status === "ended" || p.status === "erased")) {
    add("reshared", "shared again after it ended — a new grant; read it as new");
  } else if (readable(c.status) && readable(p.status) && p.grant !== null && c.grant !== null && lc(p.grant) !== lc(c.grant)) {
    add("reshared", "the grant changed — terms changed or it was shared again; read it as new");
  } else if (c.status === "stale" && p.status === "live") {
    add("stale", "a newer version exists that this grant cannot open — do not fetch");
  } else if (c.status === "live" && p.status === "stale") {
    add("updated", "the grant was wrapped again for the newer version — read it again");
  } else if (c.status === "live" && p.status === "live" && versionMove(p, c) === "moved") {
    add("updated", "a newer version is readable — read it again");
  } else if (c.status === "live" && p.status === "live" && versionMove(p, c) === "incomparable" && !singleWriteUnderOneGrant(p, c)) {
    add("updated", c.seq === null && c.commitment === null
      ? "the map no longer states this share's version — an event reset it (shared again, or written again); read it again"
      : "the earlier map cannot say whether this version is newer — it states no version to compare, or no grant to count the write sequence under — and this is not a single write under one grant; read it again");
  } else if ((c.status === "unknown") !== (p.status === "unknown")) {
    add("undetermined", `status moved from "${displayUntrusted(p.statusText, 32)}" to "${displayUntrusted(c.statusText, 32)}"`);
  }

  if (c.copiesInvalidBefore !== null && c.status !== "erased" && !sameCib(c.copiesInvalidBefore, p.copiesInvalidBefore)) {
    add("copies-invalidated", "copiesInvalidBefore was set or moved — copies made before it are invalid");
  }
  return out;
}

function transitionsOfArrival(c: ShareStateEntry): ShareTransition[] {
  const out: ShareTransition[] = [];
  const add = (kind: ShareTransitionKind, why: string): void => {
    out.push({ kind, key: c.key, sharer: c.sharer, cellId: c.cellId, before: null, after: c, why });
  };
  if (c.status === "live") add("new", "a share this map did not hold before");
  else if (c.status === "stale") add("new", "a share this map did not hold before — already stale: do not fetch");
  else if (c.status === "ended") add("ended", endedWhy(c, true));
  else if (c.status === "erased") add("erased", "first seen already erased — delete any cached copies");
  else add("undetermined", `first seen with status "${displayUntrusted(c.statusText, 32)}"`);
  if (c.copiesInvalidBefore !== null && c.status !== "erased") {
    add("copies-invalidated", "copies made before copiesInvalidBefore are invalid");
  }
  return out;
}

export function shareTransitions(previous: ShareStateMap | null, current: ShareStatesRead): ShareTransitionReport {
  if (current.kind !== "present") {
    const scope = gateScope({ unit: "share key", examined: 0, discriminating: 0, discriminator: "could be compared with an earlier map" });
    if (current.kind === "summary") {
      const s = current.summary;
      return {
        baseline: "unusable",
        transitions: [],
        scope,
        verdict: `SUMMARY ONLY — the recall carried the map's summary without its entries (${countsText(s.counts)} as of ${isoOrNull(s.asOf)}): transitions and versions cannot be seen, and what the counts oblige is unnamed until the entries are read`,
      };
    }
    const why = current.kind === "absent" ? "the client does not run the feed" : `the map is malformed (${current.why})`;
    return {
      baseline: "unusable",
      transitions: [],
      scope,
      verdict: `NO SHARE MAP — ${why}: transitions, stale versions and erasures cannot be seen, and the listing triage is all there is`,
    };
  }
  const cur = current.map;
  if (previous === null || previous.since === null) {
    const unreconciled = previous === null ? "" : " (the earlier map was never reconciled, so it is no baseline)";
    return {
      baseline: "first",
      transitions: [],
      scope: gateScope({ unit: "share key", examined: cur.entries.length, discriminating: 0, discriminator: "could be compared with an earlier map" }),
      verdict: cur.since === null
        ? `NO BASELINE YET${unreconciled} — the map is not reconciled, so it is not kept; transitions are reported from the first reconciled map`
        : `FIRST SHARE MAP${unreconciled} — ${cur.entries.length} entr${cur.entries.length === 1 ? "y" : "ies"} kept as the baseline; transitions are reported from the next map`,
    };
  }

  const baseline: ShareBaseline = cur.since === null ? "unreconciled" : previous.since === cur.since ? "continuous" : "restarted";
  const whole = mapIsWhole(cur);
  const before = new Map(previous.entries.map((e) => [e.key, e] as const));
  const after = new Map(cur.entries.map((e) => [e.key, e] as const));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();

  const transitions: ShareTransition[] = [];
  let discriminating = 0;
  for (const k of keys) {
    const p = before.get(k);
    const c = after.get(k);
    if (p !== undefined && c !== undefined) {
      discriminating += 1;
      transitions.push(...transitionsOfPair(p, c));
    } else if (c !== undefined) {
      discriminating += 1;
      transitions.push(...transitionsOfArrival(c));
    } else if (p !== undefined) {
      if (p.status === "ended" || p.status === "erased") {
        discriminating += 1;
        continue;
      }
      if (whole) {
        discriminating += 1;
        transitions.push({ kind: "vanished", key: k, sharer: p.sharer, cellId: p.cellId, before: p, after: null,
          why: "missing from a whole map, and no end was reported — possibly erased" });
      } else {
        transitions.push({ kind: "undetermined", key: k, sharer: p.sharer, cellId: p.cellId, before: p, after: null,
          why: cur.since === null ? "missing from an unreconciled map — no conclusion" : "missing from an incomplete map — no conclusion" });
      }
    }
  }

  const scope = gateScope({
    unit: "share key",
    examined: keys.length,
    discriminating,
    discriminator: "could be compared with an earlier map",
  });
  const counts = new Map<ShareTransitionKind, number>();
  for (const t of transitions) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);
  const listed = [...counts].map(([k, n]) => `${n} ${k}`).join(", ");
  const note =
    baseline === "restarted"
      ? `; the map restarted at ${cur.since === null ? "?" : new Date(cur.since).toISOString()} — changes before it show only as missing keys`
      : baseline === "unreconciled"
        ? "; the map is not reconciled — missing keys conclude nothing"
        : "";
  const verdict = !scope.conclusive
    ? `VERDICT WITHHELD — ${scope.note}`
    : `${transitions.length === 0 ? "no transitions" : listed} across ${keys.length} key(s) (${baseline}${whole ? "" : ", not whole"})${note}`;
  return { baseline, transitions, scope, verdict };
}

export function nextBaseline(previous: ShareStateMap | null, read: ShareStatesRead): ShareStateMap | null {
  if (read.kind !== "present" || read.map.since === null) return previous;
  const cur = read.map;
  if (cur.complete || previous === null) return cur;
  const held = new Set(cur.entries.map((e) => e.key));
  const kept = previous.entries.filter((e) => !held.has(e.key));
  if (kept.length === 0) return cur;
  return {
    since: cur.since,
    complete: false,
    ...(cur.summary !== undefined ? { summary: cur.summary } : {}),
    entries: [...cur.entries, ...kept].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    defects: [
      ...cur.defects,
      `${kept.length} entr${kept.length === 1 ? "y" : "ies"} kept from the earlier baseline — absent from a map that is not complete`,
    ],
  };
}

export type CarriedObligationKind = Exclude<ShareObligationKind, "stale">;

export interface OpenObligation {
  readonly id: string;
  readonly kind: CarriedObligationKind;
  readonly key: string;
  readonly sharer: string;
  readonly cellId: string;
  readonly grant: string | null;
  readonly senderVerified: boolean;
  readonly why: string;
  readonly source: "entry" | "vanished";
  readonly firstSeen: number;
  readonly lastHeld: number | null;
}

export interface ObligationCarry {
  readonly open: readonly OpenObligation[];
  readonly carried: readonly OpenObligation[];
  readonly withdrawn: readonly { readonly obligation: OpenObligation; readonly why: string }[];
  readonly added: number;
  readonly fresh: readonly string[];
  readonly handled: number;
}

export function carryObligations(
  previous: readonly OpenObligation[],
  read: ShareStatesRead,
  report: ShareTransitionReport | null,
  seen: ReadonlySet<string>,
  now: number,
): ObligationCarry {
  const byId = new Map(previous.map((o) => [o.id, o] as const));
  let handled = 0;
  for (const o of previous) {
    if (seen.has(o.id) && byId.delete(o.id)) handled += 1;
  }
  const heldNow = new Set<string>();
  const fresh: string[] = [];
  const see = (o: ShareObligation, source: OpenObligation["source"]): void => {
    if (o.kind === "stale") return;
    const id = obligationKey(o);
    if (source === "entry") heldNow.add(id);
    if (seen.has(id)) return;
    const was = byId.get(id);
    if (was === undefined) fresh.push(id);
    const e = o.entry;
    byId.set(id, {
      id, kind: o.kind, key: e.key, sharer: e.sharer, cellId: e.cellId, grant: e.grant, senderVerified: e.senderVerified,
      why: o.why,
      source: was?.source === "entry" ? "entry" : source,
      firstSeen: was?.firstSeen ?? now,
      lastHeld: source === "entry" ? now : was?.lastHeld ?? null,
    });
  };
  for (const o of shareObligations(read)) see(o, "entry");
  for (const t of report?.transitions ?? []) {
    if (t.kind === "vanished" && t.before !== null) see({ kind: "possibly-erased", entry: t.before, why: t.why }, "vanished");
  }

  const withdrawn: { obligation: OpenObligation; why: string }[] = [];
  if (read.kind === "present") {
    for (const o of [...byId.values()]) {
      if (o.kind !== "possibly-erased" || heldNow.has(o.id)) continue;
      const e = entryFor(read.map, o.sharer, o.cellId);
      const readable = e !== undefined && (e.status === "live" || e.status === "stale") && e.copiesInvalidBefore === null;
      if (readable && o.grant !== null && e.grant !== null && lc(o.grant) === lc(e.grant)) {
        byId.delete(o.id);
        withdrawn.push({ obligation: o, why: "the same grant is readable again with no copies invalidated — an erasure ends the grant, so the absence was the map's" });
      }
    }
  }

  const open = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { open, carried: open.filter((o) => !heldNow.has(o.id)), withdrawn, added: fresh.length, fresh: fresh.sort(), handled };
}

export interface ObligationLedgerRead {
  readonly open: readonly OpenObligation[];
  readonly defects: readonly string[];
}

const CARRIED_KINDS: ReadonlySet<string> = new Set(["erased", "copies-invalid", "possibly-erased"]);

export function readObligationLedger(raw: unknown): ObligationLedgerRead {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { open: [], defects: ["the obligation ledger is not an object"] };
  const doc = raw as Record<string, unknown>;
  if (doc["v"] !== 1) return { open: [], defects: [`the obligation ledger's version is ${displayUntrusted(JSON.stringify(doc["v"]) ?? "absent", 32)}, not 1`] };
  const rows = doc["open"];
  if (!Array.isArray(rows)) return { open: [], defects: ["the obligation ledger's open is not an array"] };
  const open: OpenObligation[] = [];
  const defects: string[] = [];
  const ids = new Set<string>();
  rows.forEach((row: unknown, i: number) => {
    const bad = (why: string): void => { defects.push(`ledger row ${i}: ${why} — an obligation may be lost`); };
    if (typeof row !== "object" || row === null || Array.isArray(row)) return bad("not an object");
    const r = row as Record<string, unknown>;
    const { id, kind, key, sharer, cellId, grant, senderVerified, why, source, firstSeen, lastHeld } = r;
    if (typeof id !== "string" || typeof key !== "string" || typeof sharer !== "string" || typeof cellId !== "string" || typeof why !== "string") {
      return bad("id, key, sharer, cellId and why must be strings");
    }
    if (typeof kind !== "string" || !CARRIED_KINDS.has(kind)) return bad(`kind ${displayUntrusted(JSON.stringify(kind) ?? "absent", 32)} is not a carried kind`);
    if (grant !== null && typeof grant !== "string") return bad("grant must be a string or null");
    if (typeof senderVerified !== "boolean") return bad("senderVerified must be a boolean");
    if (source !== "entry" && source !== "vanished") return bad("source must be entry or vanished");
    if (typeof firstSeen !== "number" || !Number.isFinite(firstSeen)) return bad("firstSeen must be a finite number");
    if (lastHeld !== null && (typeof lastHeld !== "number" || !Number.isFinite(lastHeld))) return bad("lastHeld must be a finite number or null");
    if (key !== refKey({ sharer, cellId })) return bad("key is not the key of its sharer and cellId");
    let named: unknown;
    try { named = JSON.parse(id); } catch { named = undefined; }
    if (!Array.isArray(named) || named[0] !== "obligation" || named[1] !== kind || named[2] !== key) return bad("id does not name this row's kind and key");
    if (ids.has(id)) return bad("a second row with the same id");
    ids.add(id);
    open.push({ id, kind: kind as CarriedObligationKind, key, sharer, cellId, grant, senderVerified, why, source, firstSeen, lastHeld });
  });
  return { open, defects };
}

export function versionKey(e: ShareStateEntry): string {
  const version = e.commitment !== null ? lc(e.commitment) : e.seq !== null ? `seq:${e.seq}` : null;
  return JSON.stringify([e.key, lc(e.grant), version]);
}

export interface ReadMark {
  readonly read: boolean;
  readonly why: string;
  readonly awaitsVersion?: true;
}

function someVersionMarked(e: ShareStateEntry, seen: ReadonlySet<string>): boolean {
  const grant = lc(e.grant);
  for (const member of seen) {
    let parts: unknown;
    try {
      parts = JSON.parse(member);
    } catch {
      continue;
    }
    if (Array.isArray(parts) && parts.length === 3 && parts[0] === e.key && parts[1] === grant && typeof parts[2] === "string") return true;
  }
  return false;
}

export function readMarkOf(e: ShareStateEntry, seen: ReadonlySet<string>): ReadMark {
  if (seen.has(versionKey(e))) {
    return { read: true, why: e.commitment === null && e.seq === null ? "read while the map stated no version for it" : "this version was read" };
  }
  if (e.commitment === null && e.seq === null && e.copiesInvalidBefore === null && someVersionMarked(e, seen)) {
    return { read: false, awaitsVersion: true, why: "a version of it was read, and the map states no version to compare with yet — nothing says a newer one exists; compare again after the feed's next reconciliation" };
  }
  if (seen.has(e.key)) {
    if (e.status === "live" && e.seq === "1" && e.copiesInvalidBefore === null) {
      return { read: true, why: "read before versions were tracked, and the cell has a single write" };
    }
    return { read: false, why: "read before versions were tracked, and the cell was written again or its copies invalidated — read it again" };
  }
  return { read: false, why: "not read" };
}

export function unreadVersions(read: ShareStatesRead, seen: ReadonlySet<string>): readonly { entry: ShareStateEntry; why: string; awaitsVersion?: true }[] {
  if (read.kind !== "present") return [];
  const out: { entry: ShareStateEntry; why: string; awaitsVersion?: true }[] = [];
  for (const e of read.map.entries) {
    if (e.status !== "live") continue;
    const m = readMarkOf(e, seen);
    if (!m.read) out.push({ entry: e, why: m.why, ...(m.awaitsVersion === true ? { awaitsVersion: true as const } : {}) });
  }
  return out;
}

export const MIN_CITED_ID_LENGTH = 8;

export interface Citations {
  readonly searched: boolean;
  readonly names: readonly string[];
  readonly why: string;
}

const ALNUM = /^[A-Za-z0-9]$/;

export function citingNotes(cellId: string, notes: readonly { readonly name: string; readonly text: string }[]): Citations {
  if (cellId.length < MIN_CITED_ID_LENGTH) {
    return { searched: false, names: [], why: `the id is shorter than ${MIN_CITED_ID_LENGTH} characters and would match ordinary text — not searched` };
  }
  const names: string[] = [];
  for (const n of notes) {
    for (let from = 0; ;) {
      const at = n.text.indexOf(cellId, from);
      if (at < 0) break;
      const before = at === 0 ? "" : n.text[at - 1]!;
      const after = n.text[at + cellId.length] ?? "";
      if (!ALNUM.test(before) && !ALNUM.test(after)) {
        names.push(n.name);
        break;
      }
      from = at + 1;
    }
  }
  return { searched: true, names, why: `${names.length} of ${notes.length} note(s) cite the full id; abbreviated citations are not searched` };
}

export interface NoticePolicy {
  readonly segregated?: readonly string[];
  readonly known?: readonly string[];
  readonly citations?: ReadonlyMap<string, Citations>;
}

const KIND_ORDER: readonly ShareTransitionKind[] = [
  "erased", "copies-invalidated", "vanished", "ended", "reshared", "updated", "stale", "new", "undetermined",
];

function senderPhrase(e: { sharer: string; senderVerified: boolean }, known: readonly string[] | undefined): string {
  const who = displayUntrusted(e.sharer.slice(0, 8), 32);
  const base = e.senderVerified ? `from ${who}` : `listed as from ${who} (unverified until read)`;
  return known !== undefined && !sharerMatches(e.sharer, known, "known") ? `${base}, a sharer not vouched for` : base;
}

export function renderShareNotices(
  report: ShareTransitionReport,
  obligations: readonly ShareObligation[],
  policy: NoticePolicy = {},
): string[] {
  const segregated = policy.segregated ?? [];
  const known = policy.known;
  const lines: string[] = [`share map: ${report.verdict}`];

  const isSegregated = (sharer: string): boolean => segregated.length > 0 && sharerMatches(sharer, segregated, "segregated");
  const segCount = new Map<string, number>();
  const count = (sharer: string): void => {
    const p = displayUntrusted(sharer.slice(0, 8), 32);
    segCount.set(p, (segCount.get(p) ?? 0) + 1);
  };

  const shown: ShareTransition[] = [];
  for (const t of report.transitions) {
    if (isSegregated(t.sharer)) count(t.sharer);
    else shown.push(t);
  }
  const pending = obligations.filter((o) => {
    if (isSegregated(o.entry.sharer)) {
      count(o.entry.sharer);
      return false;
    }
    return true;
  });
  for (const [p, n] of segCount) {
    lines.push(`SEGREGATED — ${n} item(s) listed as from ${p}: re-file unread; not itemised`);
  }

  const cite = (key: string): string => {
    const c = policy.citations?.get(key);
    if (c === undefined) return "";
    if (!c.searched) return `; notes not searched: ${c.why}`;
    const names = c.names.slice(0, 8).map((n) => displayUntrusted(n, 64));
    const more = c.names.length > names.length ? `, +${c.names.length - names.length} more` : "";
    return c.names.length === 0
      ? `; no note cites the full id (abbreviated citations are not searched)`
      : `; ${c.names.length} note(s) cite it: ${names.join(", ")}${more} — flagged, never deleted automatically`;
  };

  shown.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const expressed = new Set<string>();
  for (const t of shown) {
    const e = t.after ?? t.before!;
    const obliges = t.kind === "erased" || t.kind === "vanished" || (t.kind === "ended" && endedMayHideErasure(e));
    lines.push(`${t.kind}: "${displayUntrusted(t.cellId)}" ${senderPhrase(e, known)} — ${t.why}${obliges ? cite(t.key) : ""}`);
    const states: ShareObligationKind | undefined =
      t.kind === "erased" ? "erased"
        : t.kind === "copies-invalidated" ? "copies-invalid"
          : t.kind === "ended" && endedMayHideErasure(e) ? "possibly-erased"
            : t.kind === "stale" || (t.kind === "new" && e.status === "stale") ? "stale"
              : undefined;
    if (states !== undefined) expressed.add(`${t.key}\u0000${states}`);
  }
  for (const o of pending) {
    if (expressed.has(`${o.entry.key}\u0000${o.kind}`)) continue;
    const obliges = o.kind === "erased" || o.kind === "possibly-erased" || o.kind === "copies-invalid";
    lines.push(`still ${o.kind}: "${displayUntrusted(o.entry.cellId)}" ${senderPhrase(o.entry, known)} — ${o.why}${obliges ? cite(o.entry.key) : ""}`);
  }
  return lines;
}

export function renderCarriedObligations(carry: ObligationCarry, policy: NoticePolicy = {}): string[] {
  const segregated = policy.segregated ?? [];
  const known = policy.known;
  const isSegregated = (sharer: string): boolean => segregated.length > 0 && sharerMatches(sharer, segregated, "segregated");
  const lines: string[] = [];
  const segCount = new Map<string, number>();
  const cite = (key: string): string => {
    const c = policy.citations?.get(key);
    if (c === undefined) return "";
    if (!c.searched) return `; notes not searched: ${c.why}`;
    return c.names.length === 0
      ? "; no note cites the full id (abbreviated citations are not searched)"
      : `; ${c.names.length} note(s) cite it: ${c.names.slice(0, 8).map((n) => displayUntrusted(n, 64)).join(", ")}${c.names.length > 8 ? `, +${c.names.length - 8} more` : ""} — flagged, never deleted automatically`;
  };
  const fresh = new Set(carry.fresh);
  for (const o of carry.carried) {
    if (fresh.has(o.id)) continue;
    if (isSegregated(o.sharer)) {
      const p = displayUntrusted(o.sharer.slice(0, 8), 32);
      segCount.set(p, (segCount.get(p) ?? 0) + 1);
      continue;
    }
    const held = o.lastHeld === null ? "no map ever held it" : `last held by a map ${new Date(o.lastHeld).toISOString()}`;
    lines.push(`still owed, ${o.kind} (first seen ${new Date(o.firstSeen).toISOString()}; ${held}; not in the current map): "${displayUntrusted(o.cellId)}" ${senderPhrase(o, known)} — ${o.why}${cite(o.key)}`);
  }
  for (const [p, n] of segCount) lines.push(`SEGREGATED — ${n} owed item(s) listed as from ${p}: re-file unread; not itemised`);
  for (const w of carry.withdrawn) {
    if (isSegregated(w.obligation.sharer)) continue;
    lines.push(`withdrawn, ${w.obligation.kind}: "${displayUntrusted(w.obligation.cellId)}" — ${w.why}`);
  }
  return lines;
}
