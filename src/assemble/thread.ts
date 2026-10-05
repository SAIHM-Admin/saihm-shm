import type { AdmittedRow } from "../retrieval/semantic.js";
import type { LifecycleStamp, StampLookup, ThreadStatus } from "../retrieval/thread_lifecycle.js";
import { claimAge, type Freshness, type FreshnessLookup, type LabelLookup } from "./brief.js";

export interface ThreadMember {
  readonly cellId: string;
  readonly ingestEpoch: number;
  readonly label?: string;
  readonly stamp: LifecycleStamp;
  readonly freshness: Freshness;
  readonly ageHours?: number;
  readonly advisory?: "verify-before-acting";
  readonly supersededBy?: string;
  readonly derived?: true;
  readonly retiredBy?: string;
}

export interface ThreadTransition {
  readonly cellId: string;
  readonly atEpoch: number;
  readonly from: ThreadStatus | undefined;
  readonly to: ThreadStatus;
}

export type ThreadVerdict = "no-thread-signal" | "empty" | "assembled";

export interface ThreadAccount {
  readonly thread: string;
  readonly verdict: ThreadVerdict;
  readonly members: readonly ThreadMember[];
  readonly latest?: ThreadMember;
  readonly status?: ThreadStatus;
  readonly transitions: readonly ThreadTransition[];
  readonly kinds: Readonly<Record<string, number>>;
  readonly superseded: number;
  readonly stale: number;
  readonly unauditable: number;
  readonly advisories: number;
  readonly firstEpoch?: number;
  readonly lastEpoch?: number;
  readonly note: string;
  readonly scoped?: { readonly name: string; readonly notAdmitted: number };
}

export interface AssembleThreadOptions {
  readonly stampOf: StampLookup;
  readonly corpusHasThreadStamps: boolean;
  readonly labelOf?: LabelLookup;
  readonly freshnessOf?: FreshnessLookup;
  readonly nowEpoch?: number;
  readonly staleAfterHours?: number;
}

function ageOf(ingestEpoch: number, nowEpoch: number | undefined): number | undefined {
  return claimAge(ingestEpoch, nowEpoch).ageHours;
}

export function assembleThread(
  thread: string,
  rows: readonly AdmittedRow[],
  opts: AssembleThreadOptions,
): ThreadAccount {
  const nowEpoch = Number.isFinite(opts.nowEpoch) ? (opts.nowEpoch as number) : undefined;
  const policy =
    Number.isFinite(opts.staleAfterHours) && (opts.staleAfterHours as number) >= 0
      ? (opts.staleAfterHours as number)
      : undefined;
  const freshnessOf = opts.freshnessOf;
  const labelOf = opts.labelOf;

  const sorted = [...rows].sort(
    (a, b) => a.ingestEpoch - b.ingestEpoch || (a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0),
  );

  const members: ThreadMember[] = [];
  const transitions: ThreadTransition[] = [];
  const kinds: Record<string, number> = {};
  let superseded = 0;
  let stale = 0;
  let unauditable = 0;
  let advisories = 0;
  let lastStatus: ThreadStatus | undefined;

  for (const r of sorted) {
    let stamp: LifecycleStamp;
    try {
      stamp = opts.stampOf(r.cellId) ?? {};
    } catch {
      stamp = {};
    }
    let freshness: Freshness = "unauditable";
    if (freshnessOf !== undefined) {
      try {
        freshness = freshnessOf(r.cellId);
      } catch {
        freshness = "unauditable";
      }
    }
    const age = ageOf(r.ingestEpoch, nowEpoch);
    const advisory = age !== undefined && policy !== undefined && age > policy ? ("verify-before-acting" as const) : undefined;
    const label = labelOf?.(r.cellId);
    const member: ThreadMember = {
      cellId: r.cellId,
      ingestEpoch: r.ingestEpoch,
      ...(label !== undefined ? { label } : {}),
      stamp,
      freshness,
      ...(age !== undefined ? { ageHours: age } : {}),
      ...(advisory !== undefined ? { advisory } : {}),
      ...(r.supersededBy !== undefined ? { supersededBy: r.supersededBy } : {}),
      ...(r.derived ? { derived: true as const } : {}),
      ...(r.retiredBy !== undefined ? { retiredBy: r.retiredBy } : {}),
    };
    members.push(member);

    const kind = stamp.kind ?? "unstamped-kind";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (member.supersededBy !== undefined) superseded++;
    if (freshness === "stale") stale++;
    if (freshness === "unauditable") unauditable++;
    if (advisory !== undefined) advisories++;
    if (stamp.status !== undefined && stamp.status !== lastStatus) {
      transitions.push({ cellId: r.cellId, atEpoch: r.ingestEpoch, from: lastStatus, to: stamp.status });
      lastStatus = stamp.status;
    }
  }

  const latest = members.length > 0 ? members[members.length - 1] : undefined;
  const verdict: ThreadVerdict =
    members.length > 0 ? "assembled" : opts.corpusHasThreadStamps ? "empty" : "no-thread-signal";

  const note =
    verdict === "no-thread-signal"
      ? `NO THREAD SIGNAL: the corpus carries no thread stamps, so this says nothing about "${thread}" — stamp cells (thread:/status:/kind:) before reading a workstream through this surface.`
      : verdict === "empty"
        ? `EMPTY: stamps exist in the corpus, none carry thread "${thread}" (or none are admitted as-of/in scope). Not evidence the work never happened — evidence it was not stamped into this thread.`
        : `ASSEMBLED: ${members.length} member(s), oldest first; ${transitions.length} status transition(s)` +
          (lastStatus !== undefined ? `, standing ${lastStatus}` : ", no status stamps") +
          (freshnessOf === undefined ? "; freshness NOT checked (no lookup) — every member is unauditable" : `; ${stale} stale, ${unauditable} unauditable`) +
          (nowEpoch === undefined ? "; no reference time, so no ages" : policy === undefined ? "; ages computed, no staleness policy given" : `; ${advisories} past the ${policy}h policy`) +
          ". No prose is synthesized: the structure is the account.";

  return {
    thread,
    verdict,
    members,
    ...(latest !== undefined ? { latest } : {}),
    ...(lastStatus !== undefined ? { status: lastStatus } : {}),
    transitions,
    kinds,
    superseded,
    stale,
    unauditable,
    advisories,
    ...(members.length > 0 ? { firstEpoch: members[0]!.ingestEpoch, lastEpoch: latest!.ingestEpoch } : {}),
    note,
  };
}

export function renderThreadAccount(account: ThreadAccount): string {
  const lines: string[] = [];
  lines.push(`THREAD ${account.thread} — ${account.verdict}${account.status !== undefined ? ` · standing ${account.status}` : ""} · ${account.members.length} member(s)`);
  lines.push(`  ${account.note}`);
  if (account.scoped !== undefined) {
    lines.push(`  scope ${account.scoped.name}: ${account.scoped.notAdmitted} member(s) of this thread NOT ADMITTED — absent from the status, the course and the list below`);
  }
  if (account.transitions.length > 0) {
    lines.push("  course:");
    for (const t of account.transitions) lines.push(`    ${t.from ?? "∅"} → ${t.to}  @${t.atEpoch}h  (${t.cellId})`);
  }
  for (const m of account.members) {
    const bits = [
      `@${m.ingestEpoch}h`,
      m.stamp.status !== undefined ? m.stamp.status : "-",
      m.stamp.kind !== undefined ? m.stamp.kind : "-",
      m.freshness,
      m.ageHours !== undefined ? `${m.ageHours}h old` : "age n/a",
      m.advisory !== undefined ? "VERIFY BEFORE ACTING" : "",
      m.supersededBy !== undefined ? `superseded-by ${m.supersededBy}` : "",
    ].filter((b) => b !== "");
    lines.push(`  · ${m.cellId}  [${bits.join(" · ")}]${m.label !== undefined ? `  ${m.label}` : ""}`);
  }
  return lines.join("\n");
}
