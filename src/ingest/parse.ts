import { createHash } from "node:crypto";
import { isDerivedLabel, labelOfDerived } from "../derived/codec.js";
import type { Namespace, ParsedLabel, SupersessionEdge } from "./types.js";

const TAG_NAMESPACE: Readonly<Record<string, Namespace>> = {
  POLICY: "policy",
  INVARIANT: "policy",
  CONTRACT: "policy",
  STATE: "operational",
  RESUME: "operational",
  CHECKPOINT: "operational",
  STATUS: "operational",
  SAIHM: "operational",
  LESSON: "learning",
  HG: "learning",
  CORRECTION: "learning",
  GUARD: "learning",
  STRATEGY: "strategy",
  PROJECT: "strategy",
  PHASE: "strategy",
  PLAN: "strategy",
  SHM: "strategy",
  INBOUND: "comms",
  OUTBOUND: "comms",
  OUTREACH: "comms",
  MAIL: "comms",
  REFERENCE: "reference",
  REF: "reference",
  FEEDBACK: "feedback",
};

const DECAY_EXEMPT_TAGS: ReadonlySet<string> = new Set(["POLICY", "INVARIANT", "CONTRACT"]);

const TAG_RE = /^([A-Z][A-Z0-9]+)(?=[\s:#\-]|$)/;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const LINK_RE = /\[\[([^\[\]]+)\]\]/g;
const CELLID_RE = /\b(?:[0-9a-f]{64}\b|[0-9a-f]{32}\b(?!\u2026|\.\.\.))/gi;
const CELLID_PREFIX_RE = /\b([0-9a-f]{8,63})(?:\u2026|\.\.\.)([0-9a-f]{2,63})?/gi;
const SUPERSEDE_MARKER_RE = /\b(supersed\w*|replaces?|deprecat\w*|obsolet\w*|predecessor)\b/i;

export function extractTag(text: string): string | null {
  const m = TAG_RE.exec(text.trimStart());
  return m ? m[1]!.toUpperCase() : null;
}

export function classifyTag(tag: string | null): {
  namespace: Namespace;
  salienceFloor: boolean;
  decayExempt: boolean;
  quarantined: boolean;
} {
  if (tag === null) {
    return { namespace: "unknown", salienceFloor: false, decayExempt: false, quarantined: true };
  }
  const namespace = TAG_NAMESPACE[tag] ?? "generic";
  const exempt = DECAY_EXEMPT_TAGS.has(tag);
  return { namespace, salienceFloor: exempt, decayExempt: exempt, quarantined: false };
}

export function parseValidTime(text: string): string | undefined {
  const m = ISO_DATE_RE.exec(text);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const yy = Number(y);
  const mm = Number(mo);
  const dd = Number(d);
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) {
    return undefined;
  }
  return `${y}-${mo}-${d}`;
}

export function extractLinks(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(LINK_RE)) {
    const slug = m[1]!.trim();
    if (slug.length > 0 && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

export function extractCellIdPrefixRefs(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CELLID_PREFIX_RE)) {
    const head = m[1]!.toLowerCase();
    const tail = m[2]?.toLowerCase();
    const ref = tail === undefined ? head : `${head}\u2026${tail}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

export function extractCellIdRefs(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CELLID_RE)) {
    const id = m[0].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function detectSupersession(
  text: string,
  links: readonly string[],
  cellIdRefs: readonly string[],
  cellIdPrefixRefs: readonly string[] = [],
): { supersedes: SupersessionEdge[]; supersededHint: boolean; prefixCandidates: string[] } {
  const hasMarker = SUPERSEDE_MARKER_RE.test(text);
  if (!hasMarker) return { supersedes: [], supersededHint: false, prefixCandidates: [] };
  const supersedes: SupersessionEdge[] = [
    ...cellIdRefs.map((target): SupersessionEdge => ({ kind: "cellId", target })),
    ...links.map((target): SupersessionEdge => ({ kind: "name", target })),
  ];
  return { supersedes, supersededHint: supersedes.length === 0, prefixCandidates: [...cellIdPrefixRefs] };
}

export function sourceHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseLabelRaw(label: string): ParsedLabel {
  const tag = extractTag(label);
  const cls = classifyTag(tag);
  const links = extractLinks(label);
  const cellIdRefs = extractCellIdRefs(label);
  const cellIdPrefixRefs = extractCellIdPrefixRefs(label);
  const { supersedes, supersededHint, prefixCandidates } = detectSupersession(
    label,
    links,
    cellIdRefs,
    cellIdPrefixRefs,
  );
  const advisory = parseValidTime(label);
  return {
    tag: tag ?? "UNKNOWN",
    namespace: cls.namespace,
    salienceFloor: cls.salienceFloor,
    decayExempt: cls.decayExempt,
    quarantined: cls.quarantined,
    ...(advisory !== undefined ? { validTimeAdvisoryIso: advisory } : {}),
    links,
    supersedes,
    supersededHint,
    supersedesPrefixCandidates: prefixCandidates,
  };
}

export function parseLabel(label: string): ParsedLabel {
  if (isDerivedLabel(label)) {
    const inner = parseLabelRaw(labelOfDerived(label) ?? "");
    return { ...inner, tag: "SHM-DERIVED", namespace: "derived", salienceFloor: false, decayExempt: false, quarantined: false };
  }
  return parseLabelRaw(label);
}
