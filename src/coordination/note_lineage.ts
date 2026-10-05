import { parseFrontmatter } from "../adapter/frontmatter.js";
import { citingNotes, MIN_CITED_ID_LENGTH, type OpenObligation } from "./share_states.js";
import { displayUntrusted } from "./untrusted_text.js";

export interface NoteRef {
  readonly name: string;
  readonly text: string;
}

export interface NoteLineage {
  readonly sources: readonly string[];
  readonly mentions: readonly string[];
  readonly defects: readonly string[];
}

const CELL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function idsOf(key: string, value: string | undefined, defects: string[]): string[] {
  if (value === undefined) return [];
  let v = value.trim();
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  const out: string[] = [];
  for (const raw of v.split(/[\s,]+/)) {
    const token = raw.replace(/^["']|["']$/g, "");
    if (token === "") continue;
    if (!CELL_ID.test(token) || token.length < MIN_CITED_ID_LENGTH) {
      defects.push(`${key}: "${displayUntrusted(token, 80)}" is not a full cell id — it declares nothing`);
      continue;
    }
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

export function readNoteLineage(text: string): NoteLineage {
  const fm = parseFrontmatter(text).keys;
  const defects: string[] = [];
  const sources = idsOf("sources", fm.get("sources"), defects);
  const declaredMentions = idsOf("mentions", fm.get("mentions"), defects);
  const both = declaredMentions.filter((id) => sources.includes(id));
  for (const id of both) defects.push(`"${displayUntrusted(id, 80)}" is declared a source AND a mention — it counts as a source`);
  return { sources, mentions: declaredMentions.filter((id) => !sources.includes(id)), defects };
}

export type CitationStanding = "derived" | "mentioned" | "undeclared";

export function standingOf(note: NoteRef, cellId: string, lineage: NoteLineage = readNoteLineage(note.text)): CitationStanding | undefined {
  if (lineage.sources.includes(cellId)) return "derived";
  if (lineage.mentions.includes(cellId)) return "mentioned";
  return citingNotes(cellId, [note]).names.length > 0 ? "undeclared" : undefined;
}

export interface LineageDuty {
  readonly obligation: OpenObligation;
  readonly derived: readonly string[];
  readonly undeclared: readonly string[];
  readonly mentioned: readonly string[];
  readonly scope: string;
}

export interface LineageReport {
  readonly duties: readonly LineageDuty[];
  readonly defects: readonly { readonly note: string; readonly defect: string }[];
}

export function lineageDuties(open: readonly OpenObligation[], notes: readonly NoteRef[]): LineageReport {
  const lineages = notes.map((n) => ({ note: n, lineage: readNoteLineage(n.text) }));
  const defects = lineages.flatMap(({ note, lineage }) => lineage.defects.map((defect) => ({ note: note.name, defect })));
  const duties = open.map((obligation): LineageDuty => {
    const derived: string[] = [];
    const undeclared: string[] = [];
    const mentioned: string[] = [];
    for (const { note, lineage } of lineages) {
      const s = standingOf(note, obligation.cellId, lineage);
      if (s === "derived") derived.push(note.name);
      else if (s === "undeclared") undeclared.push(note.name);
      else if (s === "mentioned") mentioned.push(note.name);
    }
    const found = derived.length + undeclared.length;
    const scope = obligation.cellId.length < MIN_CITED_ID_LENGTH
      ? `the id is shorter than ${MIN_CITED_ID_LENGTH} characters — neither a declaration nor a citation is matched for it; review by hand`
      : found === 0
      ? `none of ${notes.length} note(s) declares or cites this cell — a derivation that never named its source cannot be found here`
      : `${derived.length} declared, ${undeclared.length} undeclared of ${notes.length} note(s); a derivation that never named its source is not among them`;
    return { obligation, derived, undeclared, mentioned, scope };
  });
  return { duties, defects };
}

export function undeclaredCitations(notes: readonly NoteRef[], cellIds: readonly string[]): readonly { readonly note: string; readonly cellId: string }[] {
  const out: { note: string; cellId: string }[] = [];
  for (const note of notes) {
    const lineage = readNoteLineage(note.text);
    for (const cellId of cellIds) {
      if (standingOf(note, cellId, lineage) === "undeclared") out.push({ note: note.name, cellId });
    }
  }
  return out;
}

export function unknownDeclarations(notes: readonly NoteRef[], cellIds: readonly string[]): readonly { readonly note: string; readonly id: string; readonly as: "source" | "mention"; readonly why: string }[] {
  const known = new Set(cellIds);
  const out: { note: string; id: string; as: "source" | "mention"; why: string }[] = [];
  for (const note of notes) {
    const lineage = readNoteLineage(note.text);
    const each = (ids: readonly string[], as: "source" | "mention"): void => {
      for (const id of ids) {
        if (known.has(id)) continue;
        const longer = cellIds.filter((c) => c.startsWith(id)).length;
        out.push({ note: note.name, id, as, why: longer > 0
          ? `a prefix of ${longer} known id(s) — shortened: it declares nothing`
          : "no known share has this id — mistyped, or a share this listing no longer holds" });
      }
    };
    each(lineage.sources, "source");
    each(lineage.mentions, "mention");
  }
  return out;
}

export interface WithheldNote {
  readonly note: string;
  readonly because: readonly { readonly cellId: string; readonly kind: "erased" | "copies-invalid"; readonly obligationId: string }[];
}

export function notesToWithhold(report: LineageReport): readonly WithheldNote[] {
  const byNote = new Map<string, { cellId: string; kind: "erased" | "copies-invalid"; obligationId: string }[]>();
  for (const d of report.duties) {
    const kind = d.obligation.kind;
    if (kind !== "erased" && kind !== "copies-invalid") continue;
    for (const note of d.derived) {
      byNote.set(note, [...(byNote.get(note) ?? []), { cellId: d.obligation.cellId, kind, obligationId: d.obligation.id }]);
    }
  }
  return [...byNote].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([note, because]) => ({ note, because }));
}

export function handlingBlockedBy(report: LineageReport, obligationId: string): readonly string[] {
  return report.duties.filter((d) => d.obligation.id === obligationId).flatMap((d) => d.derived);
}

export function renderLineageDuties(report: LineageReport): string[] {
  const lines: string[] = [];
  const names = (ns: readonly string[]): string => ns.slice(0, 8).map((n) => displayUntrusted(n, 64)).join(", ") + (ns.length > 8 ? `, +${ns.length - 8} more` : "");
  for (const d of report.duties) {
    const cell = `"${displayUntrusted(d.obligation.cellId)}" (${d.obligation.kind})`;
    if (d.derived.length > 0) lines.push(`derived from ${cell}: ${names(d.derived)} — declared sources; handle the derived data, never deleted automatically`);
    if (d.undeclared.length > 0) lines.push(`cite ${cell} and declare nothing: ${names(d.undeclared)} — treated as derived until classified (sources: or mentions:)`);
    if (d.mentioned.length > 0) lines.push(`only point at ${cell}: ${names(d.mentioned)} — declared mentions; nothing of the cell to handle`);
    if (d.derived.length + d.undeclared.length === 0) lines.push(`${cell}: ${d.scope}`);
  }
  for (const x of report.defects) lines.push(`⚠️ lineage of ${displayUntrusted(x.note, 64)}: ${x.defect}`);
  return lines;
}
