import type { RankedHit } from "../retrieval/semantic.js";

export interface HistoryHit {
  readonly cellId: string;
  readonly ingestEpoch?: number;
  readonly label?: string;
  readonly thread?: string;
  readonly derived?: true;
  readonly supersededBy?: string;
  readonly retiredBy?: string;
}

export type ViewReason = "arrival" | "caller" | "current";

export interface HistoryView {
  readonly asOfEpoch?: number;
  readonly reason: ViewReason;
  readonly hits: readonly HistoryHit[];
  readonly note?: string;
}

export interface HistoryChange {
  readonly fromEpoch?: number;
  readonly toEpoch?: number;
  readonly entered: readonly string[];
  readonly left: readonly string[];
  readonly newlySuperseded: readonly string[];
  readonly newlyRetired: readonly string[];
}

export type HistoryVerdict =
  | "assembled"
  | "empty";

export interface HistoryReport {
  readonly query: string;
  readonly verdict: HistoryVerdict;
  readonly views: readonly HistoryView[];
  readonly changes: readonly HistoryChange[];
  readonly unstamped: number;
  readonly erasure: "absent-from-every-view";
}

export type KnowableAt = (cellId: string, asOfEpoch: number) => boolean;

export interface AssembleHistoryInput {
  readonly query: string;
  readonly current: readonly RankedHit[];
  readonly views: readonly { readonly asOfEpoch: number; readonly hits: readonly RankedHit[] }[];
  readonly reason: Exclude<ViewReason, "current">;
  readonly knowableAt: KnowableAt;
  readonly labelOf?: (cellId: string) => string | undefined;
  readonly threadOf?: (cellId: string) => string | undefined;
}

const isStamped = (e: number | undefined): e is number => e !== undefined && Number.isFinite(e) && e > 0;

export function epochsFromHits(hits: readonly RankedHit[]): number[] {
  const set = new Set<number>();
  for (const h of hits) if (isStamped(h.ingestEpoch)) set.add(h.ingestEpoch);
  return [...set].sort((a, b) => a - b);
}

function toHit(h: RankedHit, asOf: number | undefined, input: AssembleHistoryInput): HistoryHit {
  const label = input.labelOf?.(h.cellId);
  const thread = input.threadOf?.(h.cellId);
  const show = (target: string | undefined): target is string =>
    target !== undefined && (asOf === undefined || input.knowableAt(target, asOf));
  return {
    cellId: h.cellId,
    ...(isStamped(h.ingestEpoch) ? { ingestEpoch: h.ingestEpoch } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(thread !== undefined ? { thread } : {}),
    ...(h.derived === true ? { derived: true as const } : {}),
    ...(show(h.supersededBy) ? { supersededBy: h.supersededBy } : {}),
    ...(show(h.retiredBy) ? { retiredBy: h.retiredBy } : {}),
  };
}

function noteFor(epoch: number): string | undefined {
  if (Number.isNaN(epoch) || epoch === Number.NEGATIVE_INFINITY) return "non-finite epoch: the retriever answers with the empty set (fail-safe)";
  if (epoch === Number.POSITIVE_INFINITY) return "+Infinity: the retriever answers with the full live set";
  return undefined;
}

function diff(from: HistoryView, to: HistoryView): HistoryChange {
  const fromIds = new Map(from.hits.map((h) => [h.cellId, h]));
  const toIds = new Map(to.hits.map((h) => [h.cellId, h]));
  const entered: string[] = [];
  const newlySuperseded: string[] = [];
  const newlyRetired: string[] = [];
  for (const h of to.hits) {
    const before = fromIds.get(h.cellId);
    if (before === undefined) {
      entered.push(h.cellId);
      continue;
    }
    if (h.supersededBy !== undefined && before.supersededBy === undefined) newlySuperseded.push(h.cellId);
    if (h.retiredBy !== undefined && before.retiredBy === undefined) newlyRetired.push(h.cellId);
  }
  const left = from.hits.filter((h) => !toIds.has(h.cellId)).map((h) => h.cellId);
  return {
    ...(from.asOfEpoch !== undefined ? { fromEpoch: from.asOfEpoch } : {}),
    ...(to.asOfEpoch !== undefined ? { toEpoch: to.asOfEpoch } : {}),
    entered,
    left,
    newlySuperseded,
    newlyRetired,
  };
}

export function assembleHistory(input: AssembleHistoryInput): HistoryReport {
  const seen = new Set<number>();
  const asOf: HistoryView[] = [];
  const ordered = [...input.views].sort((a, b) => {
    const x = Number.isNaN(a.asOfEpoch) ? Number.NEGATIVE_INFINITY : a.asOfEpoch;
    const y = Number.isNaN(b.asOfEpoch) ? Number.NEGATIVE_INFINITY : b.asOfEpoch;
    return x - y;
  });
  for (const v of ordered) {
    if (seen.has(v.asOfEpoch)) continue;
    seen.add(v.asOfEpoch);
    const note = noteFor(v.asOfEpoch);
    asOf.push({
      asOfEpoch: v.asOfEpoch,
      reason: input.reason,
      hits: v.hits.map((h) => toHit(h, v.asOfEpoch, input)),
      ...(note !== undefined ? { note } : {}),
    });
  }
  const current: HistoryView = { reason: "current", hits: input.current.map((h) => toHit(h, undefined, input)) };
  const views = [...asOf, current];
  const changes: HistoryChange[] = [];
  for (let i = 1; i < views.length; i++) changes.push(diff(views[i - 1]!, views[i]!));
  const unstamped = input.current.filter((h) => !isStamped(h.ingestEpoch)).length;
  const verdict: HistoryVerdict = views.some((v) => v.hits.length > 0) ? "assembled" : "empty";
  return { query: input.query, verdict, views, changes, unstamped, erasure: "absent-from-every-view" };
}

const at = (e: number | undefined): string => (e === undefined ? "current" : `@${e}h`);

export function renderHistoryReport(report: HistoryReport): string {
  const lines: string[] = [];
  const current = report.views[report.views.length - 1];
  lines.push(
    `HISTORY ${JSON.stringify(report.query)} — ${report.verdict} · ${report.views.length - 1} as-of view(s) + current (${current?.hits.length ?? 0} hit(s)) · unstamped ${report.unstamped} · erased cells: ${report.erasure}`,
  );
  for (const v of report.views) {
    lines.push(`  ${at(v.asOfEpoch)} (${v.reason}): ${v.hits.length} hit(s)${v.note !== undefined ? ` — ${v.note}` : ""}`);
    for (const h of v.hits) {
      const bits = [
        h.ingestEpoch !== undefined ? `@${h.ingestEpoch}h` : "@?",
        h.derived === true ? "derived" : "raw",
        h.thread !== undefined ? `thread:${h.thread}` : "-",
        h.supersededBy !== undefined ? `superseded-by:${h.supersededBy}` : "",
        h.retiredBy !== undefined ? `retired-by:${h.retiredBy}` : "",
      ].filter((b) => b !== "");
      lines.push(`    ${h.cellId}  ${bits.join(" ")}${h.label !== undefined ? `  ${h.label}` : ""}`);
    }
  }
  if (report.changes.length > 0) {
    lines.push("  changes:");
    for (const c of report.changes) {
      lines.push(
        `    ${at(c.fromEpoch)} → ${at(c.toEpoch)}  entered [${c.entered.join(", ")}]  left [${c.left.join(", ")}]  superseded [${c.newlySuperseded.join(", ")}]  retired [${c.newlyRetired.join(", ")}]`,
      );
    }
  }
  return lines.join("\n");
}
