import type { IndexEntry, RecalledBody, RecallOptions, SaihmReadPort } from "./types.js";
import type { LifecycleStamp, StampSource } from "../retrieval/thread_lifecycle.js";

export interface FederatedSource {
  readonly tag: string;
  readonly port: SaihmReadPort;
}

export interface FederatedReadPortOptions {
  readonly tenantId?: string;
  readonly separator?: string;
  readonly agentIdHash?: string;
}

export const DEFAULT_SEPARATOR = "::";

export class FederatedReadPort implements SaihmReadPort {
  readonly tenantId: string;
  readonly agentIdHash?: string | undefined;
  readonly identityNote: string;
  private readonly sources: readonly FederatedSource[];
  private readonly sep: string;
  get separator(): string {
    return this.sep;
  }
  private recallSourceFailures = 0;

  constructor(sources: readonly FederatedSource[], opts: FederatedReadPortOptions = {}) {
    if (sources.length === 0) throw new Error("FederatedReadPort needs >=1 source");
    this.sep = opts.separator ?? DEFAULT_SEPARATOR;
    if (this.sep.length === 0) throw new Error("FederatedReadPort separator must be non-empty");
    const seen = new Set<string>();
    for (const s of sources) {
      if (!s.tag) throw new Error("FederatedReadPort source tag must be non-empty");
      if (s.tag.includes(this.sep)) {
        throw new Error(`FederatedReadPort source tag "${s.tag}" must not contain the separator "${this.sep}"`);
      }
      if (seen.has(s.tag)) throw new Error(`FederatedReadPort duplicate source tag "${s.tag}"`);
      seen.add(s.tag);
    }
    this.sources = [...sources];
    this.tenantId = opts.tenantId ?? `federated(${this.sources.map((s) => s.tag).join("+")})`;
    if (opts.agentIdHash !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(opts.agentIdHash)) throw new Error("FederatedReadPort agentIdHash must be a 64-hex agentIdHash");
      this.agentIdHash = opts.agentIdHash;
      this.identityNote = "identity given explicitly";
    } else {
      const carried = new Map<string, string[]>();
      for (const s of this.sources) if (s.port.agentIdHash !== undefined) carried.set(s.port.agentIdHash, [...(carried.get(s.port.agentIdHash) ?? []), s.tag]);
      if (carried.size === 1) {
        const [id, tags] = [...carried.entries()][0]!;
        this.agentIdHash = id;
        this.identityNote = `identity forwarded from source(s) ${tags.join(", ")}`;
      } else if (carried.size === 0) {
        this.identityNote = "no source carries an identity; pass agentIdHash to locate the erasure feed";
      } else {
        this.identityNote = `sources carry ${carried.size} distinct identities (${[...carried.values()].map((t) => t.join("+")).join(" vs ")}); none forwarded — pass agentIdHash explicitly`;
      }
    }
  }

  private prefix(tag: string, cellId: string): string {
    return `${tag}${this.sep}${cellId}`;
  }

  readonly stampOf = (cellId: string): LifecycleStamp => {
    for (const s of this.sources) {
      const p = this.prefix(s.tag, "");
      if (!cellId.startsWith(p)) continue;
      const src = s.port as Partial<StampSource>;
      if (typeof src.stamps !== "function") return {};
      return src.stamps().get(cellId.slice(p.length)) ?? {};
    }
    return {};
  };

  async readIndex(): Promise<IndexEntry[]> {
    const all: IndexEntry[] = [];
    for (const s of this.sources) {
      const entries = await s.port.readIndex();
      for (const e of entries) all.push({ ...e, cellId: this.prefix(s.tag, e.cellId) });
    }
    return all;
  }

  async recallByQuery(query: string, opts?: RecallOptions): Promise<RecalledBody[]> {
    const out: RecalledBody[] = [];
    for (const s of this.sources) {
      let bodies: readonly RecalledBody[];
      try {
        bodies = await s.port.recallByQuery(query, opts);
      } catch {
        this.recallSourceFailures++;
        continue;
      }
      for (const b of bodies) out.push({ ...b, cellId: this.prefix(s.tag, b.cellId) });
    }
    return out;
  }

  get stats(): { readonly recallSourceFailures: number } {
    return { recallSourceFailures: this.recallSourceFailures };
  }
}
