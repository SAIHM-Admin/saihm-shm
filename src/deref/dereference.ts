import type { Reranker } from "../rerank/types.js";
import {
  DEFAULT_POLICY,
  isRefusal,
  nodeFileSystem,
  resolveRoots,
  resolveToken,
  buildRootIndex,
  DEFAULT_ROOT_INDEX,
  type RootIndex,
  type RootIndexConfig,
  type DerefRoot,
  type FileSystemSeam,
  type PolicyConfig,
  type RefusalReason,
  type ResolvedFile,
} from "./policy.js";

const POINTER_RE = /(?<![\w./-])\/?[\w.-]+(?:\/[\w.-]+)*\.(?:md|ts|json)(?![\w-])/g;

export function extractPointerTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(POINTER_RE)) {
    const t = m[0];
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export interface Section {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export function splitSections(text: string, maxSectionChars: number): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let buf: string[] = [];
  let start = 1;

  let bufLen = 0;

  const flush = (endLine: number): void => {
    if (buf.length > 0 && buf.some((l) => l.trim().length > 0)) {
      sections.push({ startLine: start, endLine, text: buf.join("\n").trim() });
    }
    buf = [];
    bufLen = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const isHeading = /^#{1,6}\s/.test(line);
    const wouldOverflow = bufLen + line.length + 1 > maxSectionChars;
    if ((isHeading || wouldOverflow) && buf.length > 0) {
      flush(lineNo - 1);
      start = lineNo;
    }
    if (buf.length === 0) start = lineNo;
    buf.push(line);
    bufLen += line.length + 1;
  }
  flush(lines.length);
  return sections;
}

export interface Attachment {
  readonly cellId: string;
  readonly token: string;
  readonly root: string;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly score: number;
}

export type DerefVerdict =
  | "empty"
  | "unscorable"
  | "all-refused"
  | "nothing-cleared"
  | "attached";

export interface DerefStats {
  readonly cellsScanned: number;
  readonly tokensFound: number;
  readonly filesResolved: number;
  readonly filesRead: number;
  readonly sectionsScored: number;
  readonly attached: number;
  readonly attachedChars: number;
  readonly refusals: Readonly<Partial<Record<RefusalReason | "already-retrievable" | "over-cap", number>>>;
  readonly bareNameIndex?: { readonly filesIndexed: number; readonly dirsWalked: number; readonly truncated: boolean };
}

export interface DerefResult {
  readonly verdict: DerefVerdict;
  readonly attachments: readonly Attachment[];
  readonly stats: DerefStats;
  readonly note: string;
}

export interface DerefConfig {
  readonly maxAttachChars: number;
  readonly maxSectionChars: number;
  readonly maxFiles: number;
  readonly maxFilesPerCell: number;
  readonly maxSectionsPerFile: number;
  readonly maxSections: number;
  readonly minScore?: number;
  readonly resolveBareNames: boolean;
}

export const DEFAULT_DEREF: DerefConfig = {
  maxAttachChars: 4000,
  maxSectionChars: 1200,
  maxFiles: 12,
  maxFilesPerCell: 3,
  maxSections: 60,
  maxSectionsPerFile: 8,
  resolveBareNames: true,
};

export interface DerefCell {
  readonly cellId: string;
  readonly body: string;
}

export interface DerefOptions {
  readonly query: string;
  readonly roots: readonly DerefRoot[];
  readonly reranker?: Reranker;
  readonly config?: Partial<DerefConfig>;
  readonly policy?: Partial<PolicyConfig>;
  readonly fs?: FileSystemSeam;
  readonly isAlreadyRetrievable?: (realPath: string) => boolean;
  readonly rootIndex?: RootIndexConfig;
}

function bump(
  m: Map<RefusalReason | "already-retrievable" | "over-cap", number>,
  k: RefusalReason | "already-retrievable" | "over-cap",
  n = 1,
): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

export async function dereference(
  cells: readonly DerefCell[],
  opts: DerefOptions,
): Promise<DerefResult> {
  const cfg: DerefConfig = { ...DEFAULT_DEREF, ...opts.config };
  const policy: PolicyConfig = { ...DEFAULT_POLICY, ...opts.policy };
  const fsSeam = opts.fs ?? nodeFileSystem;
  const refusals = new Map<RefusalReason | "already-retrievable" | "over-cap", number>();
  const preparedRoots = await resolveRoots(opts.roots, fsSeam);

  const perCell = cells.map((c) => {
    const seen = new Set<string>();
    const tokens: { cellId: string; token: string }[] = [];
    for (const token of extractPointerTokens(c.body)) {
      if (seen.has(token)) continue;
      seen.add(token);
      if (tokens.length >= cfg.maxFilesPerCell) break;
      tokens.push({ cellId: c.cellId, token });
    }
    return tokens;
  });
  const candidates: { cellId: string; token: string }[] = [];
  for (let i = 0; ; i++) {
    let progressed = false;
    for (const list of perCell) {
      const item = list[i];
      if (item !== undefined) {
        candidates.push(item);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  const stats0 = { cellsScanned: cells.length, tokensFound: candidates.length };
  if (candidates.length === 0) {
    return done("empty", [], { ...stats0, filesResolved: 0, filesRead: 0, sectionsScored: 0 }, refusals,
      "No file pointers in the retrieved bodies; nothing to dereference.");
  }

  const byPath = new Map<string, { file: ResolvedFile; cellId: string }>();
  const rootIndex: RootIndex | undefined = cfg.resolveBareNames
    ? await buildRootIndex(preparedRoots, policy, fsSeam, opts.rootIndex ?? DEFAULT_ROOT_INDEX)
    : undefined;

  const stats1 = {
    ...stats0,
    ...(rootIndex
      ? { bareNameIndex: { filesIndexed: rootIndex.filesIndexed, dirsWalked: rootIndex.dirsWalked, truncated: rootIndex.truncated } }
      : {}),
  };

  for (let ci = 0; ci < candidates.length; ci++) {
    const cand = candidates[ci]!;
    if (byPath.size >= cfg.maxFiles) {
      bump(refusals, "over-cap", candidates.length - ci);
      break;
    }
    const r = await resolveToken(cand.token, preparedRoots, policy, fsSeam, rootIndex);
    if (isRefusal(r)) {
      bump(refusals, r.reason);
      continue;
    }
    if (opts.isAlreadyRetrievable?.(r.path) === true) {
      bump(refusals, "already-retrievable");
      continue;
    }
    if (!byPath.has(r.path)) byPath.set(r.path, { file: r, cellId: cand.cellId });
  }
  const filesResolved = byPath.size;
  if (filesResolved === 0) {
    return done("all-refused", [], { ...stats1, filesResolved: 0, filesRead: 0, sectionsScored: 0 }, refusals,
      "Every candidate pointer was refused; see stats.refusals for the reason counts.");
  }

  if (opts.reranker === undefined) {
    return done("unscorable", [], { ...stats1, filesResolved, filesRead: 0, sectionsScored: 0 }, refusals,
      `${filesResolved} pointer target(s) resolved but no reranker was supplied, so no section could be ` +
        "scored against the query. Nothing attached: only sections scored against the query are attached.");
  }

  const pool: { cellId: string; file: ResolvedFile; section: Section }[] = [];
  let filesRead = 0;
  for (const { file, cellId } of byPath.values()) {
    let text: string;
    try {
      text = await fsSeam.read(file.path);
    } catch {
      bump(refusals, "unreadable");
      continue;
    }
    filesRead++;
    let fromThisFile = 0;
    for (const section of splitSections(text, cfg.maxSectionChars)) {
      if (pool.length >= cfg.maxSections || fromThisFile >= cfg.maxSectionsPerFile) break;
      fromThisFile++;
      pool.push({ cellId, file, section });
    }
  }
  if (pool.length === 0) {
    return done("nothing-cleared", [], { ...stats1, filesResolved, filesRead, sectionsScored: 0 }, refusals,
      "Targets read but yielded no non-empty section.");
  }

  const scores = await opts.reranker.score(
    opts.query,
    pool.map((p) => ({ cellId: `${p.file.relPath}:${p.section.startLine}`, text: p.section.text })),
  );
  if (scores.length !== pool.length) {
    throw new Error(
      `reranker returned ${scores.length} scores for ${pool.length} sections; scores must align to input order`,
    );
  }

  const ranked = pool
    .map((p, i) => ({ ...p, score: scores[i]! }))
    .filter((p) => (cfg.minScore === undefined ? true : p.score >= cfg.minScore))
    .sort((a, b) => b.score - a.score);

  const attachments: Attachment[] = [];
  let chars = 0;
  for (const r of ranked) {
    if (chars + r.section.text.length > cfg.maxAttachChars) continue;
    chars += r.section.text.length;
    attachments.push({
      cellId: r.cellId,
      token: r.file.token,
      root: r.file.root,
      relPath: r.file.relPath,
      startLine: r.section.startLine,
      endLine: r.section.endLine,
      text: r.section.text,
      score: r.score,
    });
  }

  const base = { ...stats1, filesResolved, filesRead, sectionsScored: pool.length };
  if (attachments.length === 0) {
    return done("nothing-cleared", [], base, refusals,
      `${pool.length} section(s) scored, none attached (floor or budget). Nothing was added to the answer.`);
  }
  return done("attached", attachments, base, refusals,
    `${attachments.length} section(s) attached from ${filesRead} file(s), ${chars} char(s) of ` +
      `${cfg.maxAttachChars}. Every attachment is a child of a RETRIEVED cell; no cell was added. ` +
      "Sections are ORDERED by the query, NOT vetted for relevance — no absolute floor separates " +
      "useful from on-topic-but-useless sections.");
}

function done(
  verdict: DerefVerdict,
  attachments: Attachment[],
  s: { cellsScanned: number; tokensFound: number; filesResolved: number; filesRead: number; sectionsScored: number;
       bareNameIndex?: { filesIndexed: number; dirsWalked: number; truncated: boolean } },
  refusals: Map<RefusalReason | "already-retrievable" | "over-cap", number>,
  note: string,
): DerefResult {
  return {
    verdict,
    attachments,
    stats: {
      ...s,
      attached: attachments.length,
      attachedChars: attachments.reduce((n, a) => n + a.text.length, 0),
      refusals: Object.fromEntries(refusals),
    },
    note,
  };
}
