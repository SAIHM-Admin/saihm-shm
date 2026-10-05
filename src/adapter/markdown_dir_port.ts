import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { IndexEntry, RecalledBody, SaihmReadPort } from "../saihm_client/types.js";
import type { LifecycleStamp, StampLookup, StampSource } from "../retrieval/thread_lifecycle.js";
import { describeDocument } from "./frontmatter.js";
import { hourlyEpoch } from "./epoch.js";

const DEFAULTS = {
  extensions: [".md"] as readonly string[],
  labelChars: 120,
  maxFileBytes: 1_048_576,
  recallCap: 200,
  tier: "file",
} as const;

function posInt(v: number | undefined, dflt: number): number {
  return Number.isFinite(v) && (v as number) >= 1 ? Math.floor(v as number) : dflt;
}

export interface MarkdownDirPortOptions {
  readonly dir: string;
  readonly tenantId?: string;
  readonly extensions?: readonly string[];
  readonly exclude?: readonly string[];
  readonly labelChars?: number;
  readonly maxFileBytes?: number;
  readonly recallCap?: number;
}

export interface MarkdownDirStats {
  readonly files: number;
  readonly skippedTooLarge: number;
  readonly skippedVanished: number;
  readonly stamped: number;
  readonly dated: number;
}

interface Doc {
  readonly cellId: string;
  readonly file: string;
  readonly label: string;
  readonly body: string;
  readonly searchLower: string;
  readonly epoch: number;
  readonly byteSize: number;
}

export type { StampSource } from "../retrieval/thread_lifecycle.js";

export class MarkdownDirPort implements SaihmReadPort, StampSource {
  readonly tenantId: string;
  private readonly dir: string;
  private readonly extensions: readonly string[];
  private readonly exclude: ReadonlySet<string>;
  private readonly labelChars: number;
  private readonly maxFileBytes: number;
  private readonly recallCap: number;
  private docs: readonly Doc[] = [];
  private stampMap = new Map<string, LifecycleStamp>();
  private skippedTooLarge = 0;
  private skippedVanished = 0;
  private datedCount = 0;

  constructor(opts: MarkdownDirPortOptions) {
    this.dir = opts.dir;
    this.tenantId = opts.tenantId ?? "local";
    this.extensions = (opts.extensions ?? DEFAULTS.extensions).map((e) => e.toLowerCase());
    this.exclude = new Set(opts.exclude ?? []);
    this.labelChars = posInt(opts.labelChars, DEFAULTS.labelChars);
    this.maxFileBytes = posInt(opts.maxFileBytes, DEFAULTS.maxFileBytes);
    this.recallCap = posInt(opts.recallCap, DEFAULTS.recallCap);
  }

  readonly stampOf: StampLookup = (cellId: string): LifecycleStamp => this.stampMap.get(cellId) ?? {};

  stamps(): ReadonlyMap<string, LifecycleStamp> {
    return this.stampMap;
  }

  get stats(): MarkdownDirStats {
    let stamped = 0;
    for (const s of this.stampMap.values()) {
      if (s.thread !== undefined || s.status !== undefined || s.kind !== undefined) stamped++;
    }
    return {
      files: this.docs.length,
      skippedTooLarge: this.skippedTooLarge,
      skippedVanished: this.skippedVanished,
      stamped,
      dated: this.datedCount,
    };
  }

  async readIndex(): Promise<IndexEntry[]> {
    const entries = await readdir(this.dir, { withFileTypes: true });
    const names = entries
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((n) => this.extensions.includes(extname(n).toLowerCase()) && !this.exclude.has(n))
      .sort();

    const docs: Doc[] = [];
    const stamps = new Map<string, LifecycleStamp>();
    const seen = new Map<string, string>();
    let skipped = 0;
    let vanished = 0;
    let dated = 0;

    for (const name of names) {
      const path = join(this.dir, name);
      let st;
      try {
        st = await stat(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          vanished++;
          continue;
        }
        throw e;
      }
      if (st.size > this.maxFileBytes) {
        skipped++;
        continue;
      }
      const cellId = stemOf(name);
      const prior = seen.get(cellId);
      if (prior !== undefined) {
        throw new Error(
          `MarkdownDirPort: "${name}" and "${prior}" both map to cellId "${cellId}" in ${this.dir} — ` +
            `rename one, or narrow \`extensions\``,
        );
      }
      seen.set(cellId, name);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          seen.delete(cellId);
          vanished++;
          continue;
        }
        throw e;
      }
      const { label, stamp, body, epoch: authored } = describeDocument(text, this.labelChars);
      if (authored !== undefined) dated++;
      docs.push({
        cellId,
        file: name,
        label,
        body: text,
        searchLower: `${label}\n${body}`.toLowerCase(),
        epoch: authored ?? hourlyEpoch(st.mtimeMs),
        byteSize: Buffer.byteLength(text, "utf8"),
      });
      stamps.set(cellId, stamp);
    }

    this.docs = docs;
    this.stampMap = stamps;
    this.skippedTooLarge = skipped;
    this.skippedVanished = vanished;
    this.datedCount = dated;

    return docs.map((d) => ({
      cellId: d.cellId,
      label: d.label,
      epoch: d.epoch,
      byteSize: d.byteSize,
      tier: DEFAULTS.tier,
      forgotten: false,
    }));
  }

  async recallByQuery(query: string): Promise<RecalledBody[]> {
    const q = query.toLowerCase().trim();
    if (q === "") return [];
    const out: RecalledBody[] = [];
    for (const d of this.docs) {
      if (out.length >= this.recallCap) break;
      if (d.searchLower.includes(q)) {
        out.push({ cellId: d.cellId, plaintext: d.body, epoch: d.epoch, tier: DEFAULTS.tier });
      }
    }
    return out;
  }
}

function stemOf(name: string): string {
  const ext = extname(name);
  return ext === "" ? name : name.slice(0, -ext.length);
}

export { hourlyEpoch } from "./epoch.js";

export interface StampedSource {
  readonly tag: string;
  readonly port: StampSource;
}

export function federatedStampOf(
  sources: readonly StampedSource[],
  opts: { readonly separator?: string } = {},
): StampLookup {
  const sep = opts.separator ?? "::";
  if (sep.length === 0) throw new Error("federatedStampOf: separator must be non-empty");
  const seen = new Set<string>();
  for (const s of sources) {
    if (s.tag.length === 0) throw new Error("federatedStampOf: source tag must be non-empty");
    if (s.tag.includes(sep)) throw new Error(`federatedStampOf: source tag "${s.tag}" must not contain "${sep}"`);
    if (seen.has(s.tag)) throw new Error(`federatedStampOf: duplicate source tag "${s.tag}"`);
    seen.add(s.tag);
  }
  const prefixed = sources.map((s) => ({ prefix: `${s.tag}${sep}`, port: s.port }));
  return (cellId: string): LifecycleStamp => {
    for (const p of prefixed) {
      if (cellId.startsWith(p.prefix)) return p.port.stamps().get(cellId.slice(p.prefix.length)) ?? {};
    }
    return {};
  };
}
