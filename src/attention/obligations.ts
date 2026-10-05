import { gateScope, renderGateVerdict, type GateScope } from "../gate/index.js";

export type ObligationKind = "provenance" | "command" | "pointer" | "prohibition" | "figure";

export interface Obligation {
  readonly kind: ObligationKind;
  readonly text: string;
}

const PROVENANCE = /\b(?:measured|verified|confirmed|observed|probed?|checked|as of)\b|\b\d{4}-\d{2}-\d{2}\b/gi;
const COMMAND = /`([^`]*\b(?:npx|npm|node|git|python3?|bash|sh|curl|ps|free|grep|make|cargo|go|docker)\b[^`]*)`/g;
const POINTER = /\[\[([^\]]+)\]\]|\[[^\]]+\]\(([^)]+\.md)\)/g;
const PROHIBITION = /\b(?:NEVER|DO NOT|MUST NOT|REFUSE|FORBIDDEN|WITHDRAWN|SUPERSEDED|RESCINDED)\b/g;
const FIGURE = /(?<![\w.\-/])\d*\.\d+(?![\w]|\.\d)/g;

const KINDS: readonly (readonly [ObligationKind, RegExp])[] = [
  ["provenance", PROVENANCE],
  ["command", COMMAND],
  ["pointer", POINTER],
  ["prohibition", PROHIBITION],
  ["figure", FIGURE],
];

const PROVENANCE_WINDOW = 80;
const CLAIMISH = /`[^`]+`/g;

function warrantsSomething(text: string, at: number, len: number): boolean {
  const from = Math.max(0, at - PROVENANCE_WINDOW);
  const to = Math.min(text.length, at + len + PROVENANCE_WINDOW);
  const probe = new RegExp(CLAIMISH.source, CLAIMISH.flags);
  return probe.test(text.slice(from, to));
}

export function obligationsOf(
  text: string,
  extra: readonly (readonly [ObligationKind, RegExp])[] = [],
): Obligation[] {
  const out: Obligation[] = [];
  for (const [kind, rx] of [...KINDS, ...extra]) {
    const probe = new RegExp(rx.source, rx.flags);
    for (const m of text.matchAll(probe)) {
      if (kind === "provenance" && !warrantsSomething(text, m.index ?? 0, m[0].length)) continue;
      const raw = (m[1] ?? m[2] ?? m[0]).trim();
      out.push({ kind, text: rx.flags.includes("i") ? raw.toLowerCase() : raw });
    }
  }
  return out;
}

const SHAPE_WINDOW = 18;

function shapesAround(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const probe = new RegExp(FIGURE.source, FIGURE.flags);
  for (const m of text.matchAll(probe)) {
    const at = m.index ?? 0;
    const shape = text.slice(Math.max(0, at - SHAPE_WINDOW), at + m[0].length + SHAPE_WINDOW);
    out.set(m[0], [...(out.get(m[0]) ?? []), shape]);
  }
  return out;
}

export interface Reflow {
  readonly figure: string;
  readonly before: string;
  readonly after: string;
}

export interface EditReport {
  readonly lost: readonly Obligation[];
  readonly reflowed: readonly Reflow[];
  readonly keptCount: number;
  readonly beforeCount: number;
  readonly scope: GateScope;
  readonly safe: boolean;
  readonly verdict: string;
}

function missing(before: readonly Obligation[], after: readonly Obligation[]): Obligation[] {
  const pool = new Map<string, number>();
  for (const o of after) {
    const k = `${o.kind}\u0000${o.text}`;
    pool.set(k, (pool.get(k) ?? 0) + 1);
  }
  const lost: Obligation[] = [];
  for (const o of before) {
    const k = `${o.kind}\u0000${o.text}`;
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else lost.push(o);
  }
  return lost;
}

export function assessEdit(
  before: string,
  after: string,
  extra: readonly (readonly [ObligationKind, RegExp])[] = [],
): EditReport {
  const b = obligationsOf(before, extra);
  const a = obligationsOf(after, extra);
  const lost = missing(b, a);

  const shapesB = shapesAround(before);
  const shapesA = shapesAround(after);
  const reflowed: Reflow[] = [];
  for (const [fig, sb] of shapesB) {
    const sa = shapesA.get(fig);
    if (sa === undefined) continue;
    const pool = new Map<string, number>();
    for (const shape of sa) pool.set(shape, (pool.get(shape) ?? 0) + 1);
    for (const shape of sb) {
      const n = pool.get(shape) ?? 0;
      if (n > 0) {
        pool.set(shape, n - 1);
        continue;
      }
      reflowed.push({ figure: fig, before: shape, after: [...pool.keys()][0] ?? sa[0] ?? "" });
    }
  }

  const scope = gateScope({
    unit: "obligation",
    examined: b.length,
    discriminating: b.length,
    discriminator: "were present before the edit, so could have been lost by it",
  });
  const safe = lost.length === 0 && reflowed.length === 0;
  const head = renderGateVerdict(safe, scope, { pass: "EDIT SAFE", fail: "EDIT BROKE OBLIGATIONS" });
  const detail = [
    lost.length > 0 ? `${lost.length} LOST (${[...new Set(lost.map((o) => o.kind))].join(", ")})` : "",
    reflowed.length > 0
      ? `${reflowed.length} REFLOWED — value kept, shape changed; an external anchor keyed on the old shape now reports ABSENT`
      : "",
  ].filter((s) => s.length > 0);

  return {
    lost,
    reflowed,
    keptCount: b.length - lost.length,
    beforeCount: b.length,
    scope,
    safe,
    verdict: detail.length > 0 ? `${head} · ${detail.join(" · ")}` : head,
  };
}
