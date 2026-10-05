import type { Obligation, Reflow } from "./obligations.js";

export type AttentionSeverity = "critical" | "high" | "medium" | "low";

export interface AttentionItem {
  readonly subject: string;
  readonly severity: AttentionSeverity;
  readonly scope?: string;
  readonly reason: string;
  readonly action: string;
  readonly rank: number;
}

export type CoordinationKind =
  | "segregated-inbound"
  | "unverified-sharer"
  | "unread-inbound"
  | "erased-shared-cell"
  | "possibly-erased-shared-cell"
  | "stale-shared-cell";

export interface CoordinationFinding {
  readonly kind: CoordinationKind;
  readonly detail: string;
}

export interface AttentionInput {
  readonly subject: string;
  readonly scope?: string;
  readonly drifted?: readonly { readonly id: string; readonly stated: string; readonly actual?: string }[];
  readonly lost?: readonly Obligation[];
  readonly reflowed?: readonly Reflow[];
  readonly coverage?: number;
  readonly coordination?: readonly CoordinationFinding[];
}

export interface AttentionReport {
  readonly items: readonly AttentionItem[];
  readonly critical: number;
  readonly high: number;
  readonly clear: boolean;
  readonly verdict: string;
}

export const THIN_COVERAGE = 0.5;

const SEVERITY: Readonly<Record<number, AttentionSeverity>> = {
  1: "critical",
  2: "critical",
  3: "high",
  4: "high",
  5: "high",
  6: "medium",
  7: "medium",
  8: "low",
};

function itemsFor(input: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];
  const base = { subject: input.subject, ...(input.scope === undefined ? {} : { scope: input.scope }) };

  for (const o of input.lost ?? []) {
    if (o.kind === "prohibition") {
      out.push({ ...base, rank: 1, severity: SEVERITY[1]!, reason: `a PROHIBITION was removed: ${JSON.stringify(o.text)}`,
        action: "restore it verbatim, or record explicitly that the constraint was lifted and by whom" });
    } else if (o.kind === "command") {
      out.push({ ...base, rank: 3, severity: SEVERITY[3]!, reason: `a COMMAND was removed: ${JSON.stringify(o.text)}`,
        action: "restore it — a command that is lost gets re-derived wrong, unlike a lesson, which survives in its own file" });
    } else if (o.kind === "figure") {
      out.push({ ...base, rank: 4, severity: SEVERITY[4]!, reason: `a FIGURE is gone or changed: ${o.text}`,
        action: "confirm the number was meant to move; if it was, supersede it in the withdrawn register rather than overwriting it" });
    } else if (o.kind === "pointer") {
      out.push({ ...base, rank: 6, severity: SEVERITY[6]!, reason: `a POINTER was removed: ${o.text}`,
        action: "restore it or confirm the target is reachable from some other surface" });
    } else {
      out.push({ ...base, rank: 7, severity: SEVERITY[7]!, reason: `PROVENANCE was removed: ${JSON.stringify(o.text)}`,
        action: "re-attach a marker (a verb or an ISO date) within the claim's window, or drop the claim" });
    }
  }

  for (const d of input.drifted ?? []) {
    out.push({ ...base, rank: 2, severity: SEVERITY[2]!,
      reason: `LIVE STATE DRIFTED — ${d.id}: surface says ${JSON.stringify(d.stated)}${d.actual === undefined ? "" : `, actual ${JSON.stringify(d.actual)}`}`,
      action: "re-derive and correct the surface BEFORE acting on it; a resume carrying one wrong live value spends the session on it" });
  }

  for (const r of input.reflowed ?? []) {
    out.push({ ...base, rank: 5, severity: SEVERITY[5]!,
      reason: `REFLOWED around ${r.figure} — the value survived, the shape did not`,
      action: "run the checks that key on this line; an anchor matching the old shape now reports ABSENT rather than WRONG" });
  }

  for (const c of input.coordination ?? []) {
    if (c.kind === "segregated-inbound") {
      out.push({ ...base, rank: 2, severity: SEVERITY[2]!, reason: `SEGREGATED INBOUND — ${c.detail}`,
        action: "re-file it UNREAD; reading is the irreversible step, and a boundary crossed cannot be uncrossed by noticing afterwards" });
    } else if (c.kind === "erased-shared-cell") {
      out.push({ ...base, rank: 2, severity: SEVERITY[2]!, reason: `ERASED SHARED CELL — ${c.detail}`,
        action: "delete cached copies before using any of it; review the notes that cite it — the erasure is the owner's decision, so notes are flagged, never deleted automatically" });
    } else if (c.kind === "possibly-erased-shared-cell") {
      out.push({ ...base, rank: 7, severity: SEVERITY[7]!, reason: `POSSIBLY ERASED SHARED CELL — ${c.detail}`,
        action: "treat cached copies as withdrawn until a read or the sharer confirms otherwise; a reconciliation cannot tell an erasure from a revocation" });
    } else if (c.kind === "stale-shared-cell") {
      out.push({ ...base, rank: 8, severity: SEVERITY[8]!, reason: `STALE SHARED CELL — ${c.detail}`,
        action: "do not fetch it — the grant cannot open the newest version; keep the held copy and wait for the grant to be wrapped again" });
    } else if (c.kind === "unverified-sharer") {
      out.push({ ...base, rank: 7, severity: SEVERITY[7]!, reason: `UNVERIFIED SHARER — ${c.detail}`,
        action: "check sha256 of the DECODED signing key against the agent id before reading or replying; the content may be fine, its warrant is absent" });
    } else {
      out.push({ ...base, rank: 8, severity: SEVERITY[8]!, reason: `UNREAD INBOUND — ${c.detail}`,
        action: "enumerate them — the listing carries no labels, so an unread item's urgency is UNKNOWN, which is the argument for reading now rather than for deferring" });
    }
  }

  const cov = input.coverage;
  if (cov !== undefined) {
    const usable = Number.isFinite(cov) && cov >= 0 && cov <= 1;
    if (!usable) {
      out.push({ ...base, rank: 8, severity: SEVERITY[8]!,
        reason: `COVERAGE UNREPORTABLE — the surface supplied ${String(cov)}, which is not a fraction`,
        action: "fix the producer: a coverage that cannot be read is not the same as a coverage that is low" });
    } else if (cov < THIN_COVERAGE) {
      out.push({ ...base, rank: 8, severity: SEVERITY[8]!,
        reason: `THIN COVERAGE — only ${(cov * 100).toFixed(0)}% of this surface's local claims are checkable`,
        action: "give the load-bearing claims a probe, or mark them explicitly as unverified so they stop reading as verified" });
    }
  }
  return out;
}

export function attentionQueue(inputs: readonly AttentionInput[]): AttentionReport {
  const items = inputs.flatMap(itemsFor).sort((a, b) => a.rank - b.rank || a.subject.localeCompare(b.subject));
  const critical = items.filter((i) => i.severity === "critical").length;
  const high = items.filter((i) => i.severity === "high").length;

  const examinable = inputs.some(
    (i) => (i.lost?.length ?? 0) > 0 || (i.drifted?.length ?? 0) > 0 || (i.reflowed?.length ?? 0) > 0 || (i.coordination?.length ?? 0) > 0 || i.coverage !== undefined,
  );
  const clear = items.length === 0 && examinable;

  const verdict =
    items.length > 0
      ? `${items.length} need attention — ${critical} critical, ${high} high; act on rank ${items[0]!.rank} first`
      : examinable
        ? "CLEAR — every surface checked carried its obligations and its live claims held"
        : "VACUOUS — nothing examinable was supplied, so an empty queue says nothing about the surfaces";

  return { items, critical, high, clear, verdict };
}
