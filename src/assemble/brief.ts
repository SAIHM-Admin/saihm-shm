import type { RankedHit, MatchProvenance } from "../retrieval/semantic.js";
import type { LinkGraph } from "../retrieval/link_graph.js";
import type { StandingStatus } from "../standing/standing_answers.js";

export type Freshness = StandingStatus;

export type LabelLookup = (cellId: string) => string | undefined;

export type FreshnessLookup = (cellId: string) => Freshness;

export type ThreadLookup = (cellId: string) => string | undefined;

export interface AssemblyConfig {
  readonly bridgeDegreeFraction: number;
  readonly minBridgeDegree: number;
}

export const DEFAULT_ASSEMBLY: AssemblyConfig = {
  bridgeDegreeFraction: 0.5,
  minBridgeDegree: 2,
};

function resolveConfig(
  partial: Partial<AssemblyConfig> | undefined,
): AssemblyConfig {
  const merged = { ...DEFAULT_ASSEMBLY, ...partial };
  const fraction = Number.isFinite(merged.bridgeDegreeFraction)
    ? Math.min(1, Math.max(0, merged.bridgeDegreeFraction))
    : DEFAULT_ASSEMBLY.bridgeDegreeFraction;
  const minDegree = Number.isFinite(merged.minBridgeDegree)
    ? Math.max(1, Math.floor(merged.minBridgeDegree))
    : DEFAULT_ASSEMBLY.minBridgeDegree;
  return { bridgeDegreeFraction: fraction, minBridgeDegree: minDegree };
}

const MAX_CLAIMABLE_AGE_HOURS = 1_000_000;

export function claimAge(
  ingestEpoch: number | undefined,
  nowEpoch: number | undefined,
): { ingestEpoch?: number; ageHours?: number } {
  if (
    ingestEpoch === undefined ||
    !Number.isFinite(ingestEpoch) ||
    ingestEpoch <= 0
  )
    return {};
  if (nowEpoch === undefined) return { ingestEpoch };
  const delta = nowEpoch - ingestEpoch;
  return delta < 0 || delta > MAX_CLAIMABLE_AGE_HOURS
    ? { ingestEpoch }
    : { ingestEpoch, ageHours: Math.floor(delta) };
}
const stampOf = claimAge;

export interface BriefCell {
  readonly cellId: string;
  readonly rank: number;
  readonly label?: string;
  readonly matched?: MatchProvenance;
  readonly freshness: Freshness;
  readonly supersededBy?: string;
  readonly ingestEpoch?: number;
  readonly ageHours?: number;
}

export interface BriefGroup {
  readonly members: readonly BriefCell[];
  readonly bestRank: number;
  readonly anchorLabel?: string;
  readonly edges: number;
}

export interface BriefConnector {
  readonly cell: BriefCell;
  readonly degree: number;
  readonly touches: readonly number[];
}

export interface ThreadGroup {
  readonly thread: string;
  readonly members: readonly BriefCell[];
  readonly bestRank: number;
}

export interface ThreadView {
  readonly consulted: boolean;
  readonly groups: readonly ThreadGroup[];
  readonly unstamped: number;
  readonly spanning: number;
}

export type BriefVerdict = "empty" | "unstructured" | "assembled";

export interface AssemblyStats {
  readonly cells: number;
  readonly inducedEdges: number;
  readonly groups: number;
  readonly multiCellGroups: number;
  readonly singletons: number;
  readonly connectors: number;
  readonly largestGroup: number;
  readonly freshnessKnown: number;
  readonly freshnessUnknown: number;
  readonly stale: number;
  readonly duplicatesDropped: number;
}

export interface Brief {
  readonly verdict: BriefVerdict;
  readonly posture: readonly BriefCell[];
  readonly groups: readonly BriefGroup[];
  readonly connectors: readonly BriefConnector[];
  readonly threads: ThreadView;
  readonly stats: AssemblyStats;
  readonly note: string;
}

export interface AssembleOptions {
  readonly labelOf?: LabelLookup;
  readonly freshnessOf?: FreshnessLookup;
  readonly posture?: readonly RankedHit[];
  readonly nowEpoch?: number;
  readonly staleAfterHours?: number;
  readonly graph?: LinkGraph;
  readonly threadOf?: ThreadLookup;
  readonly config?: Partial<AssemblyConfig>;
}

export function assembleBrief(
  hits: readonly RankedHit[],
  opts: AssembleOptions = {},
): Brief {
  const cfg = resolveConfig(opts.config);
  const freshnessOf = opts.freshnessOf;
  const labelOf = opts.labelOf;
  const nowEpoch = Number.isFinite(opts.nowEpoch)
    ? (opts.nowEpoch as number)
    : undefined;
  const staleAfterHours =
    Number.isFinite(opts.staleAfterHours) &&
    (opts.staleAfterHours as number) >= 0
      ? (opts.staleAfterHours as number)
      : undefined;

  const postureSeen = new Set<string>();
  const postureCells: BriefCell[] = (opts.posture ?? [])
    .filter(
      (h) =>
        !postureSeen.has(h.cellId) && postureSeen.add(h.cellId) !== undefined,
    )
    .map((h) => ({
      cellId: h.cellId,
      rank: -1,
      ...(labelOf?.(h.cellId) !== undefined
        ? { label: labelOf(h.cellId) as string }
        : {}),
      ...(h.matched !== undefined ? { matched: h.matched } : {}),
      freshness: freshnessOf
        ? freshnessOf(h.cellId)
        : ("unauditable" as Freshness),
      ...(h.supersededBy !== undefined ? { supersededBy: h.supersededBy } : {}),
      ...stampOf(h.ingestEpoch, nowEpoch),
    }));

  const postureStale = postureCells.filter(
    (c) => c.freshness === "stale",
  ).length;
  const postureNote =
    postureCells.length === 0
      ? ""
      : ` ⚑ STANDING: ${postureCells.length} cell(s) presented UNRANKED — they answer no query and` +
        ` were not retrieved for this one; they bind anyway. Acknowledge before acting.` +
        (postureStale > 0
          ? ` ${postureStale} of them verified STALE — a standing constraint that has moved is the` +
            ` most dangerous cell here; re-read it before relying on it.`
          : "");

  const seenIds = new Set<string>();
  const ranked = hits.filter((h) =>
    seenIds.has(h.cellId) ? false : (seenIds.add(h.cellId), true),
  );

  const cells: BriefCell[] = ranked.map((h, rank) => {
    const label = labelOf?.(h.cellId);
    return {
      cellId: h.cellId,
      rank,
      ...(label !== undefined ? { label } : {}),
      ...(h.matched !== undefined ? { matched: h.matched } : {}),
      freshness: freshnessOf
        ? freshnessOf(h.cellId)
        : ("unauditable" as Freshness),
      ...(h.supersededBy !== undefined ? { supersededBy: h.supersededBy } : {}),
      ...stampOf(h.ingestEpoch, nowEpoch),
    };
  });

  const freshnessUnknown = cells.filter(
    (c) => c.freshness === "unauditable",
  ).length;
  const stale = cells.filter((c) => c.freshness === "stale").length;
  const baseFreshness = {
    freshnessKnown: cells.length - freshnessUnknown,
    freshnessUnknown,
    stale,
    duplicatesDropped: hits.length - ranked.length,
  };

  const threads: ThreadView = ((): ThreadView => {
    const threadOf = opts.threadOf;
    if (threadOf === undefined) {
      return { consulted: false, groups: [], unstamped: cells.length, spanning: 0 };
    }
    const byThread = new Map<string, BriefCell[]>();
    let unstamped = 0;
    for (const c of cells) {
      const t = threadOf(c.cellId);
      if (typeof t !== "string" || t.length === 0) {
        unstamped++;
        continue;
      }
      const arr = byThread.get(t);
      if (arr) arr.push(c);
      else byThread.set(t, [c]);
    }
    const threadGroups = [...byThread.entries()]
      .map(([thread, members]) => ({ thread, members, bestRank: members[0]!.rank }))
      .sort((a, b) => a.bestRank - b.bestRank);
    const covered = threadGroups.reduce((n, g) => n + g.members.length, 0);
    if (covered + unstamped !== cells.length) {
      throw new Error(
        `assembleBrief: thread partition covers ${covered} + ${unstamped} unstamped != ${cells.length} cells`,
      );
    }
    return {
      consulted: true,
      groups: threadGroups,
      unstamped,
      spanning: threadGroups.filter((g) => g.members.length >= 2).length,
    };
  })();

  const threadNote = !threads.consulted
    ? ""
    : threads.groups.length === 0
      ? ` Thread axis consulted: none of the ${cells.length} cell(s) carry a thread stamp.`
      : ` Thread axis: ${threads.groups.length} thread(s), ${threads.spanning} with 2+ cells` +
        (threads.unstamped > 0 ? `, ${threads.unstamped} unstamped` : "") +
        `. ${threads.spanning >= 2 ? "This set SPANS threads — do not read it as one story." : "Not a spanning set."}` +
        " Partitioned by thread stamp, not by link adjacency.";

  if (cells.length === 0) {
    return {
      verdict: "empty",
      threads,
      groups: [],
      connectors: [],
      stats: {
        cells: 0,
        inducedEdges: 0,
        groups: 0,
        multiCellGroups: 0,
        singletons: 0,
        connectors: 0,
        largestGroup: 0,
        ...baseFreshness,
      },
      posture: postureCells,
      note:
        "empty: retrieval returned no cells to organize. This is not evidence that no relevant memory exists." +
        postureNote +
        threadNote,
    };
  }

  const inSet = new Map(cells.map((c) => [c.cellId, c] as const));
  const adj = new Map<string, string[]>();
  for (const c of cells) adj.set(c.cellId, []);
  let inducedEdges = 0;
  if (opts.graph) {
    for (const c of cells) {
      for (const n of opts.graph.neighbours(c.cellId)) {
        if (!inSet.has(n) || n === c.cellId) continue;
        if (c.cellId < n) {
          adj.get(c.cellId)!.push(n);
          adj.get(n)!.push(c.cellId);
          inducedEdges++;
        }
      }
    }
  }

  const maxDegree = cells.length - 1;
  const connectorIds = new Set<string>();
  for (const c of cells) {
    const degree = adj.get(c.cellId)!.length;
    if (
      degree >= cfg.minBridgeDegree &&
      degree > maxDegree * cfg.bridgeDegreeFraction
    ) {
      connectorIds.add(c.cellId);
    }
  }

  const grouped = cells.filter((c) => !connectorIds.has(c.cellId));
  const seen = new Set<string>();
  const rawGroups: BriefCell[][] = [];
  for (const start of grouped) {
    if (seen.has(start.cellId)) continue;
    const comp: BriefCell[] = [];
    const stack = [start.cellId];
    seen.add(start.cellId);
    while (stack.length > 0) {
      const id = stack.pop()!;
      comp.push(inSet.get(id)!);
      for (const n of adj.get(id)!) {
        if (connectorIds.has(n) || seen.has(n)) continue;
        seen.add(n);
        stack.push(n);
      }
    }
    comp.sort((a, b) => a.rank - b.rank);
    rawGroups.push(comp);
  }
  rawGroups.sort((a, b) => a[0]!.rank - b[0]!.rank);

  const groups: BriefGroup[] = rawGroups.map((members) => {
    const ids = new Set(members.map((m) => m.cellId));
    let edges = 0;
    for (const m of members)
      for (const n of adj.get(m.cellId)!)
        if (ids.has(n) && m.cellId < n) edges++;
    const anchorLabel = members[0]!.label;
    return {
      members,
      bestRank: members[0]!.rank,
      ...(anchorLabel !== undefined ? { anchorLabel } : {}),
      edges,
    };
  });

  const groupIndexOf = new Map<string, number>();
  groups.forEach((g, i) =>
    g.members.forEach((m) => groupIndexOf.set(m.cellId, i)),
  );

  const connectors: BriefConnector[] = cells
    .filter((c) => connectorIds.has(c.cellId))
    .map((c) => {
      const neighbours = adj.get(c.cellId)!;
      const touches = [
        ...new Set(
          neighbours
            .map((n) => groupIndexOf.get(n))
            .filter((i): i is number => i !== undefined),
        ),
      ].sort((a, b) => a - b);
      return { cell: c, degree: neighbours.length, touches };
    });

  const multiCellGroups = groups.filter((g) => g.members.length > 1).length;
  const singletons = groups.filter((g) => g.members.length === 1).length;
  const largestGroup = groups.reduce(
    (m, g) => Math.max(m, g.members.length),
    0,
  );
  const relating = connectors.filter((c) => c.touches.length >= 2).length;

  const structured = multiCellGroups > 0 || relating > 0;
  const stats: AssemblyStats = {
    cells: cells.length,
    inducedEdges,
    groups: groups.length,
    multiCellGroups,
    singletons,
    connectors: connectors.length,
    largestGroup,
    ...baseFreshness,
  };

  const freshnessNote =
    baseFreshness.freshnessKnown === 0
      ? " Freshness UNAUDITABLE for all cells (nothing could check) — currency is not claimed."
      : baseFreshness.stale > 0
        ? ` ${baseFreshness.stale} of ${cells.length} cell(s) verified STALE.`
        : ` Freshness verified for ${baseFreshness.freshnessKnown} of ${cells.length} cell(s).`;

  const stamped = cells.filter((c) => c.ingestEpoch !== undefined).length;
  const ages = cells
    .map((c) => c.ageHours)
    .filter((a): a is number => a !== undefined);
  const oldest = ages.reduce((m, a) => (a > m ? a : m), 0);
  const overdue =
    staleAfterHours !== undefined
      ? ages.filter((a) => a > staleAfterHours).length
      : 0;
  const ageNote =
    cells.length === 0
      ? ""
      : stamped === 0
        ? " No cell carries an ingest stamp; age is not claimed."
        : ages.length === 0
          ? nowEpoch === undefined
            ? ` Ingest-stamped ${stamped} of ${cells.length} cell(s); no reference time supplied, so no age is claimed.`
            :
              ` Ingest-stamped ${stamped} of ${cells.length} cell(s); the reference time is not usable against these stamps (unit mismatch or clock skew), so no age is claimed.`
          : ` Ingest-stamped ${stamped} of ${cells.length} cell(s); oldest ~${oldest}h ago` +
            ` (source epoch, hourly — the adapter's axis: a writer's \`date:\`/\`updated:\` stamp when present, else mtime).` +
            (staleAfterHours === undefined
              ? ""
              : overdue > 0
                ? ` ${overdue} older than ${staleAfterHours}h — verify before acting.`
                : ` None older than ${staleAfterHours}h.`);

  if (!structured) {
    const why =
      inducedEdges === 0
        ? `no cell links to any other, so there is nothing to organize`
        : `every cell relates to most of the others, so no grouping distinguishes them`;
    return {
      verdict: "unstructured",
      groups,
      connectors,
      threads,
      posture: postureCells,
      stats,
      note:
        `unstructured: ${cells.length} cell(s), ${inducedEdges} induced edge(s) — ${why}. ` +
        `Assembly adds nothing here; read the ranking, not this brief.` +
        freshnessNote +
        ageNote +
        postureNote +
        threadNote,
    };
  }

  return {
    verdict: "assembled",
    groups,
    connectors,
    threads,
    posture: postureCells,
    stats,
    note:
      `assembled: ${cells.length} cell(s) into ${multiCellGroups} related group(s), ${singletons} unrelated ` +
      `singleton(s), ${connectors.length} connector(s), from ${inducedEdges} induced edge(s). ` +
      `No cell was added or removed.` +
      (baseFreshness.duplicatesDropped > 0
        ? ` ${baseFreshness.duplicatesDropped} duplicate row(s) were present in the input and collapsed.`
        : "") +
      freshnessNote +
      ageNote +
      postureNote +
      threadNote,
  };
}
