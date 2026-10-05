import type { RecalledBody } from "../saihm_client/types.js";
import type { BodyStore } from "../store/body_store.js";
import { SupersedeLedger } from "./supersede.js";
import type { BodyFetchHint, BodySource, ErasableBodySource, ServeStep } from "./types.js";

export interface PersistentBodySourceOptions {
  readonly onServed?: (step: ServeStep, ms: number) => void;
  readonly clock?: () => number;
}

export interface PersistentBodyStats {
  readonly atRestHits: number;
  readonly misses: number;
  readonly filled: number;
  readonly skippedPartial: number;
  readonly storeErrors: number;
  readonly unmappable: number;
  readonly olderNotWritten: number;
}

export interface WarmFillResult {
  readonly attempted: number;
  readonly filled: number;
  readonly skippedPartial: number;
  readonly errors: number;
}

export type PersistOutcome = "filled" | "partial" | "erased" | "error" | "unmappable" | "superseded";
type FillOutcome = PersistOutcome;

export class PersistentBodySource implements ErasableBodySource {
  private readonly erased = new Set<string>();
  private readonly superseded = new SupersedeLedger();
  private readonly unlinkOwed = new Set<string>();
  private atRestHits = 0;
  private misses = 0;
  private filled = 0;
  private skippedPartial = 0;
  private storeErrors = 0;
  private unmappable = 0;
  private olderNotWritten = 0;

  constructor(
    private readonly inner: BodySource,
    private readonly store: BodyStore,
    private readonly opts: PersistentBodySourceOptions = {},
  ) {}

  async fetchByIds(cellIds: readonly string[], hint?: BodyFetchHint): Promise<RecalledBody[]> {
    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const id of cellIds) {
      if (!seen.has(id)) {
        seen.add(id);
        uniq.push(id);
      }
    }

    const clock = this.opts.clock ?? (() => performance.now());
    const t0 = clock();
    const stored = await Promise.all(
      uniq.map(async (id) => {
        if (this.erased.has(id) || this.unlinkOwed.has(id)) return undefined;
        try {
          return await this.store.get(id);
        } catch {
          this.storeErrors++;
          return undefined;
        }
      }),
    );
    const ownMs = clock() - t0;
    const resolved = new Map<string, RecalledBody>();
    const missing: string[] = [];
    for (let i = 0; i < uniq.length; i++) {
      const id = uniq[i]!;
      if (this.erased.has(id)) continue;
      const hit = stored[i];
      if (hit !== undefined) {
        this.atRestHits++;
        resolved.set(id, hit);
      } else {
        this.misses++;
        missing.push(id);
      }
    }

    if (resolved.size > 0) this.served("own", ownMs);

    if (missing.length > 0) {
      const t1 = clock();
      const since = this.superseded.stamp();
      const fetched = await this.inner.fetchByIds(missing, hint);
      if (fetched.length > 0) this.served("inner", clock() - t1);
      const fills: Promise<FillOutcome>[] = [];
      for (const b of fetched) {
        resolved.set(b.cellId, b);
        fills.push(this.fill(b, since));
      }
      for (const o of await Promise.all(fills)) this.recordFill(o);
    }

    return cellIds.map((id) => resolved.get(id)).filter((b): b is RecalledBody => b !== undefined);
  }

  async warmFill(cellIds: readonly string[]): Promise<WarmFillResult> {
    const targets = cellIds.filter((id) => !this.erased.has(id));
    if (targets.length === 0) return { attempted: 0, filled: 0, skippedPartial: 0, errors: 0 };
    const since = this.superseded.stamp();
    const fetched = await this.inner.fetchByIds(targets);
    let filled = 0;
    let skippedPartial = 0;
    let errors = 0;
    for (const o of await Promise.all(fetched.map((b) => this.fill(b, since)))) {
      this.recordFill(o);
      if (o === "filled") filled++;
      else if (o === "partial") skippedPartial++;
      else if (o === "error") errors++;
    }
    return { attempted: targets.length, filled, skippedPartial, errors };
  }

  async persist(body: RecalledBody, since: number = this.superseded.stamp()): Promise<PersistOutcome> {
    const o = await this.fill(body, since);
    this.recordFill(o);
    return o;
  }

  stamp(): number {
    return this.superseded.stamp();
  }

  async supersede(cellId: string, seq?: string): Promise<void> {
    this.superseded.supersede(cellId, seq);
    this.unlinkOwed.add(cellId);
    await this.store.delete(cellId);
    this.unlinkOwed.delete(cellId);
  }

  private async fill(b: RecalledBody, since: number): Promise<FillOutcome> {
    if (b.partial) return "partial";
    if (this.erased.has(b.cellId)) return "erased";
    if (!this.superseded.admits(b, since)) return "superseded";
    if (this.store.accepts?.(b.cellId) === false) return "unmappable";
    try {
      await this.store.put(b);
      if (this.erased.has(b.cellId)) {
        await this.store.delete(b.cellId);
        return "erased";
      }
      if (!this.superseded.admits(b, since)) {
        await this.store.delete(b.cellId);
        return "superseded";
      }
      this.unlinkOwed.delete(b.cellId);
      return "filled";
    } catch {
      return "error";
    }
  }

  private served(step: ServeStep, ms: number): void {
    try {
      this.opts.onServed?.(step, ms);
    } catch {
    }
  }

  private recordFill(o: FillOutcome): void {
    if (o === "filled") this.filled++;
    else if (o === "partial") this.skippedPartial++;
    else if (o === "error") this.storeErrors++;
    else if (o === "unmappable") this.unmappable++;
    else if (o === "superseded") this.olderNotWritten++;
  }

  async forget(cellId: string): Promise<void> {
    this.erased.add(cellId);
    await this.store.delete(cellId);
  }

  get stats(): PersistentBodyStats {
    return {
      atRestHits: this.atRestHits,
      misses: this.misses,
      filled: this.filled,
      skippedPartial: this.skippedPartial,
      storeErrors: this.storeErrors,
      unmappable: this.unmappable,
      olderNotWritten: this.olderNotWritten,
    };
  }
}
