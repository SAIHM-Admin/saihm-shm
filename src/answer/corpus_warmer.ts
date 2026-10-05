import type { IndexEntry } from "../saihm_client/types.js";
import type { WarmFillResult } from "./persistent_body_source.js";

export interface WarmProgress {
  readonly scanned: number;
  readonly alreadyWarm: number;
  readonly ineligible: number;
  readonly targeted: number;
  readonly consumed: number;
  readonly filled: number;
  readonly skippedPartial: number;
  readonly errors: number;
}

export type WarmStopReason = "complete" | "max-cells" | "budget" | "aborted" | "list-failed";

export interface WarmResult extends WarmProgress {
  readonly remaining: number;
  readonly stoppedReason: WarmStopReason;
  readonly elapsedMs: number;
}

export interface WarmOptions {
  readonly maxCells?: number;
  readonly budgetMs?: number;
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: WarmProgress) => void;
}

interface IndexReader {
  readIndex(): Promise<IndexEntry[]>;
}
interface StoredLister {
  list(): Promise<string[]>;
  accepts?(cellId: string): boolean;
}
interface WarmFillTarget {
  warmFill(cellIds: readonly string[]): Promise<WarmFillResult>;
}

const DEFAULT_BATCH = 32;

export class CorpusWarmer {
  constructor(
    private readonly index: IndexReader,
    private readonly store: StoredLister,
    private readonly target: WarmFillTarget,
  ) {}

  async warm(opts: WarmOptions = {}): Promise<WarmResult> {
    const start = Date.now();
    const batchSize =
      Number.isInteger(opts.batchSize) && (opts.batchSize as number) >= 1
        ? (opts.batchSize as number)
        : DEFAULT_BATCH;
    const maxCells = Number.isFinite(opts.maxCells)
      ? Math.max(0, Math.floor(opts.maxCells as number))
      : undefined;
    let filled = 0;
    let skippedPartial = 0;
    let errors = 0;
    let consumed = 0;

    const entries = await this.index.readIndex();
    const live = entries.filter((e) => !e.forgotten).sort((a, b) => b.epoch - a.epoch);
    const scanned = live.length;

    let storedSet: Set<string>;
    try {
      storedSet = new Set(await this.store.list());
    } catch {
      return {
        scanned, alreadyWarm: 0, ineligible: 0, targeted: 0, consumed: 0,
        filled: 0, skippedPartial: 0, errors: 0,
        remaining: 0, stoppedReason: "list-failed", elapsedMs: Date.now() - start,
      };
    }
    const notStored = live.map((e) => e.cellId).filter((id) => !storedSet.has(id));
    const targets = notStored.filter((id) => this.store.accepts?.(id) !== false);
    const targeted = targets.length;
    const ineligible = notStored.length - targeted;
    const alreadyWarm = scanned - notStored.length;

    const snapshot = (): WarmProgress => ({
      scanned, alreadyWarm, ineligible, targeted, consumed, filled, skippedPartial, errors,
    });

    let stoppedReason: WarmStopReason = "complete";
    let i = 0;
    while (i < targets.length) {
      if (opts.signal?.aborted) {
        stoppedReason = "aborted";
        break;
      }
      if (opts.budgetMs !== undefined && Date.now() - start >= opts.budgetMs) {
        stoppedReason = "budget";
        break;
      }
      if (maxCells !== undefined && consumed >= maxCells) {
        stoppedReason = "max-cells";
        break;
      }

      let end = Math.min(i + batchSize, targets.length);
      if (maxCells !== undefined) end = Math.min(end, i + (maxCells - consumed));
      const batch = targets.slice(i, end);
      i = end;

      const r = await this.target.warmFill(batch);
      filled += r.filled;
      skippedPartial += r.skippedPartial;
      errors += r.errors;
      consumed += batch.length;
      opts.onProgress?.(snapshot());
    }

    return {
      ...snapshot(),
      remaining: targeted - consumed,
      stoppedReason,
      elapsedMs: Date.now() - start,
    };
  }
}
