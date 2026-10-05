import { SessionClosedError } from "../retrieval/session_closed.js";
import { SupersedeLedger } from "./supersede.js";
import type { RecalledBody } from "../saihm_client/types.js";
import type { BodyFetchHint, BodySource, ErasableBodySource, ServeStep } from "./types.js";

export interface CachingBodySourceConfig {
  readonly maxEntries: number;
  readonly onEvict?: (cellId: string) => void;
  readonly onServed?: (step: ServeStep, ms: number) => void;
  readonly clock?: () => number;
}

export const DEFAULT_CACHE_CONFIG: CachingBodySourceConfig = { maxEntries: 4096 };

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly entries: number;
  readonly olderNotCached: number;
}

export class CachingBodySource implements ErasableBodySource {
  private fenced = false;
  private readonly cache = new Map<string, RecalledBody>();
  private readonly erased = new Set<string>();
  private readonly superseded = new SupersedeLedger();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private olderNotCached = 0;

  constructor(
    private readonly inner: BodySource,
    private readonly cfg: CachingBodySourceConfig = DEFAULT_CACHE_CONFIG,
  ) {}

  async fetchByIds(cellIds: readonly string[], hint?: BodyFetchHint): Promise<RecalledBody[]> {
    if (this.fenced) throw new SessionClosedError("CachingBodySource.fetchByIds");
    const clock = this.cfg.clock ?? (() => performance.now());
    const t0 = clock();
    const resolved = new Map<string, RecalledBody>();
    const missing: string[] = [];
    const missingSeen = new Set<string>();
    for (const id of cellIds) {
      if (resolved.has(id) || missingSeen.has(id)) continue;
      const cached = this.cache.get(id);
      if (cached !== undefined) {
        this.hits++;
        this.touch(id, cached);
        resolved.set(id, cached);
      } else {
        this.misses++;
        missingSeen.add(id);
        missing.push(id);
      }
    }

    if (resolved.size > 0) this.served("own", clock() - t0);

    if (missing.length > 0) {
      const t1 = clock();
      const since = this.superseded.stamp();
      const fetched = await this.inner.fetchByIds(missing, hint);
      const innerMs = clock() - t1;
      for (const b of fetched) {
        this.put(b.cellId, b, since);
        resolved.set(b.cellId, b);
      }
      if (fetched.length > 0) this.served("inner", innerMs);
    }

    return cellIds.map((id) => resolved.get(id)).filter((b): b is RecalledBody => b !== undefined);
  }

  fence(): void {
    this.fenced = true;
  }

  forget(cellId: string): void {
    this.erased.add(cellId);
    this.cache.delete(cellId);
  }

  supersede(cellId: string, seq?: string): void {
    this.superseded.supersede(cellId, seq);
    this.cache.delete(cellId);
  }

  has(cellId: string): boolean {
    return this.cache.has(cellId);
  }

  peek(cellId: string): RecalledBody | undefined {
    if (this.fenced) throw new SessionClosedError("CachingBodySource.peek");
    return this.cache.get(cellId);
  }

  evict(cellId: string): boolean {
    return this.cache.delete(cellId);
  }

  invalidate(): void {
    this.cache.clear();
  }

  get stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, evictions: this.evictions, entries: this.cache.size, olderNotCached: this.olderNotCached };
  }

  private put(cellId: string, body: RecalledBody, since: number): void {
    if (this.erased.has(cellId)) return;
    if (!this.superseded.admits(body, since)) {
      this.olderNotCached++;
      return;
    }
    this.cache.delete(cellId);
    this.cache.set(cellId, body);
    while (this.cache.size > this.cfg.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.evictions++;
      try {
        this.cfg.onEvict?.(oldest);
      } catch {
      }
    }
  }

  private served(step: ServeStep, ms: number): void {
    try {
      this.cfg.onServed?.(step, ms);
    } catch {
    }
  }

  private touch(cellId: string, body: RecalledBody): void {
    this.cache.delete(cellId);
    this.cache.set(cellId, body);
  }
}
