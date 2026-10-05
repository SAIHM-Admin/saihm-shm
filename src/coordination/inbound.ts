import { gateScope, type GateScope } from "../gate/scope.js";

export interface SharedRef {
  readonly sharer: string;
  readonly cellId: string;
  readonly scope?: string;
  readonly verified?: boolean;
}

export interface InboundOptions {
  readonly seen?: ReadonlySet<string>;
  readonly segregated?: readonly string[];
  readonly known?: readonly string[];
}

export interface InboundTriage {
  readonly fresh: readonly SharedRef[];
  readonly segregated: readonly SharedRef[];
  readonly unverified: readonly SharedRef[];
  readonly seenCount: number;
  readonly total: number;
  readonly scope: GateScope;
  readonly verdict: string;
}

const MIN_PREFIX = 8;

export function refKey(ref: SharedRef): string {
  return `${ref.sharer.trim().toLowerCase()}:${ref.cellId}`;
}

export function sharerMatches(id: string, prefixes: readonly string[], what: string): boolean {
  const norm = id.trim().toLowerCase();
  for (const p of prefixes) {
    const q = p.trim().toLowerCase();
    if (q.length < MIN_PREFIX) {
      throw new RangeError(
        `${what} prefix ${JSON.stringify(p)} is shorter than ${MIN_PREFIX} hex characters — ` +
          `it would match a neighbourhood of unrelated agents`,
      );
    }
    if (norm.startsWith(q)) return true;
  }
  return false;
}

export class ListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListingError";
  }
}

export class TruncatedListingError extends ListingError {
  constructor() {
    super("the share listing is truncated (sharedTruncated: true) and holds part of the shares — read a complete listing before treating it as whole");
    this.name = "TruncatedListingError";
  }
}

export function refsFromListing(result: unknown): readonly SharedRef[] {
  const r = listingRecord(result);
  const truncated = r["sharedTruncated"];
  if (truncated === true) throw new TruncatedListingError();
  if (truncated !== false) throw new ListingError("not a share listing: `sharedTruncated` is not a boolean, so whether rows are missing cannot be known");
  return rowsOf(r);
}

export type ShareListingRead =
  | { readonly complete: true; readonly refs: readonly SharedRef[] }
  | { readonly complete: false; readonly kept: "newest"; readonly refs: readonly SharedRef[] };

export function readShareListing(result: unknown): ShareListingRead {
  const r = listingRecord(result);
  const truncated = r["sharedTruncated"];
  const hasKept = Object.prototype.hasOwnProperty.call(r, "sharedKept");
  if (truncated === false) {
    if (hasKept) throw new ListingError("not a share listing: `sharedKept` on a listing that is not truncated contradicts its definition");
    return { complete: true, refs: rowsOf(r) };
  }
  if (truncated !== true) throw new ListingError("not a share listing: `sharedTruncated` is not a boolean, so whether rows are missing cannot be known");
  if (r["sharedKept"] !== "newest") throw new TruncatedListingError();
  return { complete: false, kept: "newest", refs: rowsOf(r) };
}

function listingRecord(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new ListingError("not a share listing: expected a recall result with `shared` and `sharedTruncated`");
  }
  const r = result as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(r, "next")) {
    throw new ListingError("not a share listing: the answer carries `next`, so it is one page of a paged listing — read the whole pass");
  }
  return r;
}

function rowsOf(r: Record<string, unknown>): readonly SharedRef[] {
  const rows = r["shared"];
  if (!Array.isArray(rows)) throw new ListingError("not a share listing: `shared` is not an array");
  return rows.map((row: unknown, i) => {
    const o = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : undefined;
    const sharer = o?.["sharer"];
    const cellId = o?.["cellId"];
    if (o === undefined || typeof sharer !== "string" || typeof cellId !== "string") {
      throw new ListingError(`share listing row ${i} has no string sharer and cellId`);
    }
    return {
      sharer,
      cellId,
      ...(typeof o["scope"] === "string" ? { scope: o["scope"] } : {}),
      ...(typeof o["verified"] === "boolean" ? { verified: o["verified"] } : {}),
    };
  });
}

export function triageInbound(refs: readonly SharedRef[], opts: InboundOptions = {}): InboundTriage {
  const seen = opts.seen ?? new Set<string>();
  const segregatedPins = opts.segregated ?? [];
  const knownPins = opts.known;

  const fresh: SharedRef[] = [];
  const segregated: SharedRef[] = [];
  const unverified: SharedRef[] = [];
  let seenCount = 0;

  for (const r of refs) {
    if (sharerMatches(r.sharer, segregatedPins, "segregated")) {
      segregated.push(r);
      continue;
    }
    if (seen.has(refKey(r))) {
      seenCount += 1;
      continue;
    }
    if (knownPins !== undefined && !sharerMatches(r.sharer, knownPins, "known")) {
      unverified.push(r);
      continue;
    }
    fresh.push(r);
  }

  const scope = gateScope({
    unit: "share reference",
    examined: refs.length,
    discriminating: refs.length - seenCount,
    discriminator: "were not already in the seen set",
  });

  const verdict = !scope.conclusive
    ? `VERDICT WITHHELD — ${scope.note}. An empty listing is equally consistent with an enumeration failure.`
    : `${fresh.length} to read, ${segregated.length} to RE-FILE UNREAD, ${unverified.length} needing a binding check` +
      ` (${seenCount} of ${refs.length} already handled)`;

  return { fresh, segregated, unverified, seenCount, total: refs.length, scope, verdict };
}
