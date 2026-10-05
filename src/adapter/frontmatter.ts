import { parseLifecycle, type LifecycleStamp } from "../retrieval/thread_lifecycle.js";
import { epochFromFrontmatter } from "./epoch.js";

export interface ParsedDocument {
  readonly frontmatter: ReadonlyMap<string, string>;
  readonly metadata: ReadonlyMap<string, string>;
  readonly keys: ReadonlyMap<string, string>;
  readonly body: string;
}

const METADATA_BLOCK = "metadata";

const STAMP_KEYS = ["thread", "status", "kind", "conventionVersion", "convention-version"] as const;

export function parseFrontmatter(text: string): ParsedDocument {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { frontmatter: new Map(), metadata: new Map(), keys: new Map(), body: src };
  const fm = new Map<string, string>();
  const meta = new Map<string, string>();
  let inMeta = false;
  let metaSeen = false;
  let childIndent: string | undefined;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1]!;
      const value = unquote((kv[2] ?? "").trim());
      inMeta = key === METADATA_BLOCK && value === "" && !metaSeen;
      if (key === METADATA_BLOCK) metaSeen = true;
      if (fm.has(key)) continue;
      fm.set(key, value);
      continue;
    }
    if (!inMeta) continue;
    const child = /^([ \t]+)([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!child) {
      if (/^\S/.test(line)) inMeta = false;
      continue;
    }
    childIndent ??= child[1]!;
    if (child[1] !== childIndent) continue;
    if (!meta.has(child[2]!)) meta.set(child[2]!, unquote((child[3] ?? "").trim()));
  }
  const keys = new Map<string, string>(meta);
  for (const [k, v] of fm) keys.set(k, v);
  return { frontmatter: fm, metadata: meta, keys, body: src.slice(m[0].length) };
}

function unquote(v: string): string {
  const q = v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")));
  return q ? v.slice(1, -1) : v;
}

export function stampFromDocument(text: string): LifecycleStamp {
  return stampOfParsed(parseFrontmatter(text));
}

function stampOfParsed({ keys: frontmatter, body }: ParsedDocument): LifecycleStamp {
  const pairs: string[] = [];
  for (const k of STAMP_KEYS) {
    const v = frontmatter.get(k);
    if (v !== undefined && v !== "") pairs.push(`${k}: ${v}`);
  }
  const fromFm = pairs.length > 0 ? parseLifecycle(pairs.join(" ")) : {};
  const firstLine = body.slice(0, indexOfLineEnd(body));
  const fromLine1 = parseLifecycle(firstLine);
  return {
    ...fromLine1,
    ...fromFm,
  };
}

function indexOfLineEnd(s: string): number {
  const i = s.indexOf("\n");
  return i === -1 ? s.length : i;
}

export function deriveLabel(text: string, maxChars = 120): string {
  return labelOfParsed(parseFrontmatter(text), maxChars);
}

function labelOfParsed({ keys: frontmatter, body }: ParsedDocument, maxChars: number): string {
  const desc = (frontmatter.get("description") ?? "").trim();
  const label = desc !== "" ? desc : body.replace(/\s+/g, " ").trim();
  return truncateCodePoints(label, maxChars);
}

export interface DocumentDescription {
  readonly label: string;
  readonly stamp: LifecycleStamp;
  readonly body: string;
  readonly epoch?: number;
}

export function describeDocument(text: string, maxChars = 120): DocumentDescription {
  const parsed = parseFrontmatter(text);
  const epoch = epochFromFrontmatter(parsed.keys);
  return { label: labelOfParsed(parsed, maxChars), stamp: stampOfParsed(parsed), body: parsed.body, ...(epoch !== undefined ? { epoch } : {}) };
}

export function truncateCodePoints(s: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
