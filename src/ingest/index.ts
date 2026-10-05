import type { IndexEntry } from "../saihm_client/types.js";
import type { IngestResult, IngestStats, MemoryRecord, Namespace, SupersessionEdge } from "./types.js";
import { CellIdPrefixIndex } from "./resolve_prefix.js";
import { parseLabel, sourceHash } from "./parse.js";

export { STANDING_GUIDANCE_NAMESPACES } from "./types.js";
export type {
  Namespace,
  SupersessionEdge,
  ParsedLabel,
  MemoryRecord,
  IngestStats,
  IngestResult,
} from "./types.js";
export {
  extractTag,
  classifyTag,
  parseValidTime,
  extractLinks,
  extractCellIdRefs,
  detectSupersession,
  sourceHash,
  parseLabel,
} from "./parse.js";

const ALL_NAMESPACES: readonly Namespace[] = [
  "policy",
  "operational",
  "learning",
  "strategy",
  "comms",
  "reference",
  "feedback",
  "derived",
  "generic",
  "unknown",
];

export function buildRecord(entry: IndexEntry, opts: { tenantId: string }): MemoryRecord {
  const parsed = parseLabel(entry.label);
  return {
    cellId: entry.cellId,
    tenantId: opts.tenantId,
    label: entry.label,
    ingestEpoch: entry.epoch,
    forgotten: entry.forgotten,
    sourceHash: sourceHash(entry.label),
    ...parsed,
  };
}

export function ingestIndex(
  entries: readonly IndexEntry[],
  opts: { tenantId: string; namespaceSeparator?: string },
): IngestResult {
  const records: MemoryRecord[] = [];
  const byNamespace: Record<Namespace, number> = Object.fromEntries(
    ALL_NAMESPACES.map((n) => [n, 0]),
  ) as Record<Namespace, number>;
  let quarantined = 0;
  let forgotten = 0;
  let withSupersession = 0;
  let withSupersededHint = 0;

  for (const e of entries) {
    const r = buildRecord(e, opts);
    records.push(r);
    byNamespace[r.namespace] += 1;
    if (r.quarantined) quarantined += 1;
    if (r.forgotten) forgotten += 1;
    if (r.supersedes.length > 0) withSupersession += 1;
    if (r.supersededHint) withSupersededHint += 1;
  }

  let withSupersessionViaPrefix = 0;
  let prefixAmbiguous = 0;
  let prefixUnresolved = 0;
  let withSupersessionViaStem = 0;
  let stemAmbiguous = 0;
  let cellIdUnresolved = 0;
  const needsResolution = records.some((r) => !r.forgotten && (r.supersedesPrefixCandidates.length > 0 || r.supersedes.some((e) => e.kind === "cellId")));
  if (needsResolution) {
    const index = new CellIdPrefixIndex(records.filter((r) => !r.forgotten).map((r) => r.cellId), opts.namespaceSeparator);
    for (let i = 0; i < records.length; i++) {
      const r = records[i]!;
      if (r.forgotten) continue;
      const hasPrefixes = r.supersedesPrefixCandidates.length > 0;
      const hasFullIds = r.supersedes.some((e) => e.kind === "cellId");
      if (!hasPrefixes && !hasFullIds) continue;
      const had = r.supersedes.length > 0;

      let viaStem = 0;
      const kept: SupersessionEdge[] = [];
      for (const e of r.supersedes) {
        if (e.kind !== "cellId") {
          kept.push(e);
          continue;
        }
        const res = index.resolveExact(e.target, r.cellId);
        if (res.ok) {
          if (res.target === e.target.toLowerCase()) kept.push(e);
          else {
            kept.push({ kind: "cellIdStem", target: res.target, viaStem: e.target });
            viaStem += 1;
          }
        } else if (res.reason === "ambiguous") {
          stemAmbiguous += 1;
        } else {
          kept.push(e);
          cellIdUnresolved += 1;
        }
      }

      const gained: SupersessionEdge[] = [];
      const unresolved: string[] = [];
      for (const prefix of r.supersedesPrefixCandidates) {
        const res = index.resolve(prefix, r.cellId);
        if (res.ok) gained.push({ kind: "cellIdPrefix", target: res.target, viaPrefix: prefix });
        else {
          unresolved.push(prefix);
          if (res.reason === "ambiguous") prefixAmbiguous += 1;
          else prefixUnresolved += 1;
        }
      }

      const supersedes = [...kept, ...gained];
      const changed = viaStem > 0 || gained.length > 0 || supersedes.length !== r.supersedes.length;
      if (!changed) continue;
      records[i] = {
        ...r,
        supersedes,
        supersededHint: supersedes.length === 0,
        supersedesPrefixCandidates: unresolved,
      };
      if (viaStem > 0) withSupersessionViaStem += 1;
      if (gained.length > 0) withSupersessionViaPrefix += 1;
      const has = supersedes.length > 0;
      if (!had && has) {
        withSupersession += 1;
        withSupersededHint -= 1;
      } else if (had && !has) {
        withSupersession -= 1;
        withSupersededHint += 1;
      }
    }
  }

  const stats: IngestStats = {
    total: records.length,
    quarantined,
    forgotten,
    withSupersession,
    withSupersededHint,
    withSupersessionViaPrefix,
    prefixAmbiguous,
    prefixUnresolved,
    withSupersessionViaStem,
    stemAmbiguous,
    cellIdUnresolved,
    byNamespace,
  };
  return { records, stats };
}
