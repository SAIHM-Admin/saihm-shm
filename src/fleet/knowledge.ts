import type { RedundancyCluster } from "../consolidate/consolidator.js";

export interface FleetRow {
  readonly cellId: string;
  readonly ingestEpoch?: number;
  readonly namespace: string;
  readonly thread?: string;
  readonly supersededBy?: string;
  readonly retiredBy?: string;
  readonly derived?: true;
}

export interface FleetPolicy {
  readonly thinBelow?: number;
  readonly staleAfterHours?: number;
  readonly driftWindowHours?: number;
}

export type FleetFlag = "thin" | "stale";

export interface FleetPartition {
  readonly key: string;
  readonly cells: number;
  readonly share: number;
  readonly unstamped: number;
  readonly oldest?: number;
  readonly newest?: number;
  readonly ageHours?: number;
  readonly superseded: number;
  readonly supersessionRate: number;
  readonly recentSupersessions?: number;
  readonly retired: number;
  readonly derived: number;
  readonly flags: readonly FleetFlag[];
}

export interface ClusterSummary {
  readonly namespace: string;
  readonly size: number;
  readonly minSim: number;
  readonly cellIds: readonly string[];
}

export type FleetConcentration =
  | {
      readonly status: "computed";
      readonly clusters: number;
      readonly redundantCells: number;
      readonly redundancyRate: number;
      readonly byNamespace: readonly { readonly namespace: string; readonly clusters: number; readonly redundantCells: number }[];
      readonly largest: readonly ClusterSummary[];
    }
  | { readonly status: "not-computed" };

export type FleetVerdict = "assembled" | "empty";

export interface FleetReport {
  readonly verdict: FleetVerdict;
  readonly fleet: FleetPartition;
  readonly namespaces: readonly FleetPartition[];
  readonly threads: readonly FleetPartition[];
  readonly unthreaded: number;
  readonly concentration: FleetConcentration;
  readonly policy: FleetPolicy;
  readonly nowEpoch?: number;
  readonly notes: readonly string[];
}

export interface FleetInput {
  readonly rows: readonly FleetRow[];
  readonly clusters?: readonly RedundancyCluster[];
  readonly nowEpoch?: number;
  readonly policy?: FleetPolicy;
  readonly epochOf?: (cellId: string) => number | undefined;
}

export const LARGEST_CLUSTERS = 5;

const finitePos = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 0;
const finiteNonNeg = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v >= 0;

function partition(key: string, rows: readonly FleetRow[], fleetCells: number, input: FleetInput): FleetPartition {
  const policy = input.policy ?? {};
  let oldest: number | undefined;
  let newest: number | undefined;
  let unstamped = 0;
  let superseded = 0;
  let retired = 0;
  let derived = 0;
  const windowEvaluable = finiteNonNeg(input.nowEpoch) && finiteNonNeg(policy.driftWindowHours) && input.epochOf !== undefined;
  let recent = 0;
  for (const r of rows) {
    if (finitePos(r.ingestEpoch)) {
      if (oldest === undefined || r.ingestEpoch < oldest) oldest = r.ingestEpoch;
      if (newest === undefined || r.ingestEpoch > newest) newest = r.ingestEpoch;
    } else {
      unstamped++;
    }
    if (r.supersededBy !== undefined) {
      superseded++;
      if (windowEvaluable) {
        const at = input.epochOf!(r.supersededBy);
        if (finitePos(at) && at >= (input.nowEpoch as number) - (policy.driftWindowHours as number)) recent++;
      }
    }
    if (r.retiredBy !== undefined) retired++;
    if (r.derived === true) derived++;
  }
  const cells = rows.length;
  const ageHours = finiteNonNeg(input.nowEpoch) && newest !== undefined ? input.nowEpoch - newest : undefined;
  const flags: FleetFlag[] = [];
  if (finiteNonNeg(policy.thinBelow) && cells < policy.thinBelow) flags.push("thin");
  if (finiteNonNeg(policy.staleAfterHours) && ageHours !== undefined && ageHours > policy.staleAfterHours) flags.push("stale");
  return {
    key,
    cells,
    share: fleetCells === 0 ? 0 : cells / fleetCells,
    unstamped,
    ...(oldest !== undefined ? { oldest } : {}),
    ...(newest !== undefined ? { newest } : {}),
    ...(ageHours !== undefined ? { ageHours } : {}),
    superseded,
    supersessionRate: cells === 0 ? 0 : superseded / cells,
    ...(windowEvaluable ? { recentSupersessions: recent } : {}),
    retired,
    derived,
    flags,
  };
}

function groupBy(rows: readonly FleetRow[], keyOf: (r: FleetRow) => string | undefined): Map<string, FleetRow[]> {
  const out = new Map<string, FleetRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k === undefined) continue;
    const g = out.get(k);
    if (g) g.push(r);
    else out.set(k, [r]);
  }
  return out;
}

const bySizeThenKey = (a: FleetPartition, b: FleetPartition): number => b.cells - a.cells || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function concentration(clusters: readonly RedundancyCluster[] | undefined, fleetCells: number): FleetConcentration {
  if (clusters === undefined) return { status: "not-computed" };
  const byNs = new Map<string, { clusters: number; redundantCells: number }>();
  let redundantCells = 0;
  for (const c of clusters) {
    const extra = Math.max(0, c.cellIds.length - 1);
    redundantCells += extra;
    const g = byNs.get(c.namespace) ?? { clusters: 0, redundantCells: 0 };
    g.clusters++;
    g.redundantCells += extra;
    byNs.set(c.namespace, g);
  }
  const largest = [...clusters]
    .sort((a, b) => b.cellIds.length - a.cellIds.length || (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0))
    .slice(0, LARGEST_CLUSTERS)
    .map((c) => ({ namespace: c.namespace, size: c.cellIds.length, minSim: c.minSim, cellIds: c.cellIds }));
  return {
    status: "computed",
    clusters: clusters.length,
    redundantCells,
    redundancyRate: fleetCells === 0 ? 0 : redundantCells / fleetCells,
    byNamespace: [...byNs.entries()]
      .map(([namespace, g]) => ({ namespace, ...g }))
      .sort((a, b) => b.redundantCells - a.redundantCells || (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0)),
    largest,
  };
}

export function assembleFleetReport(input: FleetInput): FleetReport {
  const rows = input.rows;
  const policy = input.policy ?? {};
  const fleet = partition("fleet", rows, rows.length, input);
  const namespaces = [...groupBy(rows, (r) => r.namespace).entries()].map(([k, g]) => partition(k, g, rows.length, input)).sort(bySizeThenKey);
  const threads = [...groupBy(rows, (r) => r.thread).entries()].map(([k, g]) => partition(k, g, rows.length, input)).sort(bySizeThenKey);
  const unthreaded = rows.filter((r) => r.thread === undefined).length;
  const notes: string[] = [];
  if (!finiteNonNeg(policy.thinBelow) && !finiteNonNeg(policy.staleAfterHours)) notes.push("no thinness/staleness policy supplied: no partition is flagged");
  else if (finiteNonNeg(policy.staleAfterHours) && !finiteNonNeg(input.nowEpoch)) notes.push("staleAfterHours needs nowEpoch: no partition is flagged stale");
  if (!finiteNonNeg(input.nowEpoch)) notes.push("no nowEpoch: ages not computed");
  if (finiteNonNeg(policy.driftWindowHours) && (!finiteNonNeg(input.nowEpoch) || input.epochOf === undefined)) notes.push("driftWindowHours needs nowEpoch and epochOf: recent supersessions not counted");
  if (input.clusters === undefined) notes.push("clusters not supplied: concentration not computed");
  if (fleet.unstamped > 0) notes.push(`${fleet.unstamped} row(s) carry no ingest epoch and take part in no age`);
  return {
    verdict: rows.length === 0 ? "empty" : "assembled",
    fleet,
    namespaces,
    threads,
    unthreaded,
    concentration: concentration(input.clusters, rows.length),
    policy,
    ...(finiteNonNeg(input.nowEpoch) ? { nowEpoch: input.nowEpoch } : {}),
    notes,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function partitionLine(p: FleetPartition): string {
  const bits = [
    `${p.cells} cell(s)`,
    pct(p.share),
    p.oldest !== undefined && p.newest !== undefined ? `@${p.oldest}h..@${p.newest}h` : "undated",
    p.ageHours !== undefined ? `age ${p.ageHours}h` : "",
    p.unstamped > 0 ? `unstamped ${p.unstamped}` : "",
    `superseded ${p.superseded} (${pct(p.supersessionRate)})`,
    p.recentSupersessions !== undefined ? `recent ${p.recentSupersessions}` : "",
    p.retired > 0 ? `retired ${p.retired}` : "",
    p.derived > 0 ? `derived ${p.derived}` : "",
    p.flags.length > 0 ? `[${p.flags.join(",")}]` : "",
  ].filter((b) => b !== "");
  return `${p.key}: ${bits.join(" · ")}`;
}

export function renderFleetReport(r: FleetReport): string {
  const lines: string[] = [];
  lines.push(`FLEET — ${r.verdict} · ${partitionLine(r.fleet)}`);
  lines.push(`  namespaces (${r.namespaces.length}):`);
  for (const p of r.namespaces) lines.push(`    ${partitionLine(p)}`);
  lines.push(`  threads (${r.threads.length}; unthreaded ${r.unthreaded}):`);
  for (const p of r.threads) lines.push(`    ${partitionLine(p)}`);
  if (r.concentration.status === "computed") {
    const c = r.concentration;
    lines.push(`  concentration: ${c.clusters} cluster(s) · redundant ${c.redundantCells} (${pct(c.redundancyRate)})`);
    for (const n of c.byNamespace) lines.push(`    ${n.namespace}: ${n.clusters} cluster(s), redundant ${n.redundantCells}`);
    for (const l of c.largest) lines.push(`    largest: ${l.namespace} ×${l.size} minSim ${l.minSim.toFixed(3)} [${l.cellIds.join(", ")}]`);
  } else {
    lines.push("  concentration: not computed");
  }
  if (r.notes.length > 0) {
    lines.push("  notes:");
    for (const n of r.notes) lines.push(`    ${n}`);
  }
  return lines.join("\n");
}
