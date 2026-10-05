import type { EvidenceRef } from "../standing/standing_answers.js";

export const DERIVED_MARKER = "SHM-DERIVED:v1";
export const DERIVED_LABEL_MAX = 100;
export const DERIVED_MAX_SOURCES = 200;

export type DerivedKind = "distilled" | "merged" | "checkpoint" | "conclusion";
const KINDS: ReadonlySet<string> = new Set(["distilled", "merged", "checkpoint", "conclusion"]);

export type DerivedOwnership = "agent" | "org-shared" | "org-owned";
const OWNERSHIPS: ReadonlySet<string> = new Set(["agent", "org-shared", "org-owned"]);

export interface DerivedHeader {
  readonly kind: DerivedKind;
  readonly issuer: string;
  readonly sources: readonly EvidenceRef[];
  readonly derivedAtEpoch: number;
  readonly ownership: DerivedOwnership;
  readonly supersedesDerived?: readonly string[];
  readonly threads?: readonly string[];
  readonly retires?: readonly string[];
}

export interface DerivedItem extends DerivedHeader {
  readonly label: string;
  readonly text: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function bad(msg: string): never {
  throw new Error(`derived cell: ${msg}`);
}

export function validateHeader(raw: unknown): DerivedHeader {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad("header is not an object");
  const h = raw as Record<string, unknown>;
  if (typeof h["kind"] !== "string" || !KINDS.has(h["kind"])) bad(`unknown kind ${JSON.stringify(h["kind"])}`);
  if (typeof h["issuer"] !== "string" || !HEX64.test(h["issuer"])) bad("issuer is not a 64-hex agentIdHash");
  if (!Array.isArray(h["sources"])) bad("sources is not an array");
  if (h["sources"].length > DERIVED_MAX_SOURCES) bad(`more than ${DERIVED_MAX_SOURCES} sources`);
  const sources: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const s of h["sources"] as unknown[]) {
    if (typeof s !== "object" || s === null) bad("a source is not an object");
    const r = s as Record<string, unknown>;
    if (typeof r["cellId"] !== "string" || r["cellId"] === "") bad("a source has no cellId");
    if (typeof r["fingerprint"] !== "string" || !/^[a-z0-9]+:[0-9a-f]+$/.test(r["fingerprint"])) bad(`source ${r["cellId"].slice(0, 12)}… has no scoped fingerprint`);
    if (seen.has(r["cellId"])) bad(`source ${r["cellId"].slice(0, 12)}… listed twice`);
    seen.add(r["cellId"]);
    sources.push({ cellId: r["cellId"], fingerprint: r["fingerprint"] });
  }
  if (typeof h["derivedAtEpoch"] !== "number" || !Number.isFinite(h["derivedAtEpoch"]) || h["derivedAtEpoch"] < 0) bad("derivedAtEpoch is not a non-negative finite number");
  if (typeof h["ownership"] !== "string" || !OWNERSHIPS.has(h["ownership"])) bad(`unknown ownership ${JSON.stringify(h["ownership"])}`);
  let supersedesDerived: string[] | undefined;
  if (h["supersedesDerived"] !== undefined) {
    if (!Array.isArray(h["supersedesDerived"]) || !h["supersedesDerived"].every((x) => typeof x === "string" && x !== "")) bad("supersedesDerived is not a list of cellIds");
    supersedesDerived = [...(h["supersedesDerived"] as string[])];
  }
  let retires: string[] | undefined;
  if (h["retires"] !== undefined) {
    if (!Array.isArray(h["retires"]) || !h["retires"].every((x) => typeof x === "string" && seen.has(x))) bad("retires must list a subset of sources");
    retires = [...new Set(h["retires"] as string[])];
  }
  let threads: string[] | undefined;
  if (h["threads"] !== undefined) {
    if (!Array.isArray(h["threads"]) || !h["threads"].every((x) => typeof x === "string" && /^[a-z0-9][a-z0-9-]*$/.test(x))) bad("threads is not a list of thread slugs");
    threads = [...(h["threads"] as string[])];
  }
  return {
    kind: h["kind"] as DerivedKind,
    issuer: h["issuer"],
    sources,
    derivedAtEpoch: h["derivedAtEpoch"],
    ownership: h["ownership"] as DerivedOwnership,
    ...(supersedesDerived !== undefined ? { supersedesDerived } : {}),
    ...(threads !== undefined ? { threads } : {}),
    ...(retires !== undefined ? { retires } : {}),
  };
}

export function encodeDerivedCell(item: DerivedItem): string {
  const header = validateHeader(item);
  const label = item.label.replace(/\s+/g, " ").trim();
  if (label === "") bad("label is empty");
  if (label.length > DERIVED_LABEL_MAX) bad(`label is ${label.length} chars, over ${DERIVED_LABEL_MAX}`);
  if (item.text.trim() === "") bad("text is empty — a derived cell with no content is a defect, not a placeholder");
  return `${DERIVED_MARKER} | ${label}\n${JSON.stringify(header)}\n\n${item.text}`;
}

export function isDerivedLabel(label: string): boolean {
  return label.startsWith(`${DERIVED_MARKER} | `);
}

export function labelOfDerived(indexLabel: string): string | undefined {
  if (!isDerivedLabel(indexLabel)) return undefined;
  const rest = indexLabel.slice(DERIVED_MARKER.length + 3);
  const nl = rest.indexOf("\n");
  return (nl >= 0 ? rest.slice(0, nl) : rest).trim();
}

export function parseDerivedCell(plaintext: string): DerivedItem | undefined {
  if (!isDerivedLabel(plaintext)) return undefined;
  const firstNl = plaintext.indexOf("\n");
  if (firstNl < 0) bad("marker line present but no header line follows");
  const label = plaintext.slice(DERIVED_MARKER.length + 3, firstNl).trim();
  if (label === "") bad("empty label");
  const secondNl = plaintext.indexOf("\n", firstNl + 1);
  const headerLine = secondNl < 0 ? plaintext.slice(firstNl + 1) : plaintext.slice(firstNl + 1, secondNl);
  let raw: unknown;
  try {
    raw = JSON.parse(headerLine);
  } catch {
    bad("header line is not JSON");
  }
  const header = validateHeader(raw);
  const afterHeader = secondNl < 0 ? "" : plaintext.slice(secondNl + 1);
  const text = afterHeader.startsWith("\n") ? afterHeader.slice(1) : afterHeader;
  if (text.trim() === "") bad("empty text");
  return { ...header, label, text };
}
