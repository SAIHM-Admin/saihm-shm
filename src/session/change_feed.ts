import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ChangesTracker, DEFAULT_FEED_LIVENESS_MS, feedLiveness, heldCovers, type ChangesTrackerStatus, type FeedHeartbeat, type FeedLiveness, type FeedPoint, type HeldVersion } from "../erasure/changes_feed.js";
import { applyChangesRead, ChangesFileReader, type ChangesPosition } from "../erasure/changes_reader.js";
import { ISO_UTC } from "../erasure/feed_watcher.js";

export const DEFAULT_CHANGE_FEED_POLL_MS = 1_000;
export const DEFAULT_RECONCILE_RETRY_MS = 60_000;
export const SHARE_STATES_FILENAME = "share-states.json";

export interface ChangeFeedHooks {
  readonly invalidate: (cellId: string, version: { readonly seq: string; readonly commitment: string }) => void | Promise<void>;
  readonly onChanged?: (cellId: string, version: { readonly seq: string; readonly commitment: string }) => void | Promise<void>;
  readonly reconcileByListing?: () => Promise<boolean>;
}

export interface ChangeFeedFollowerConfig {
  readonly path: string;
  readonly erasurePath: string;
  readonly shareStatesPath?: string;
  readonly agentIdHash: string;
  readonly pollMs?: number;
  readonly livenessMs?: number;
  readonly reconcileRetryMs?: number;
  readonly now?: () => number;
  readonly onError?: (err: unknown) => void;
  readonly timer?: boolean;
}

export interface ChangeFeedFollowerStatus {
  readonly path: string;
  readonly position: ChangesPosition;
  readonly tracker: ChangesTrackerStatus;
  readonly owedRefetch: number;
  readonly reconcileOwed: boolean;
  readonly liveness: FeedLiveness | null;
  readonly pulls: number;
  readonly applied: number;
  readonly echoesSkipped: number;
  readonly hookFailures: number;
  readonly reconcileAttempts: number;
  readonly reconcileCompleted: number;
}

export class ChangeFeedFollower {
  private readonly tracker = new ChangesTracker();
  private readonly reader: ChangesFileReader;
  private readonly ownWrites = new Map<string, HeldVersion>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private closed = false;
  private lastReconcileAttempt: number | null = null;
  private liveness: FeedLiveness | null = null;
  private readonly counters = { pulls: 0, applied: 0, echoesSkipped: 0, hookFailures: 0, reconcileAttempts: 0, reconcileCompleted: 0 };
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;

  constructor(
    private readonly cfg: ChangeFeedFollowerConfig,
    private readonly hooks: ChangeFeedHooks,
  ) {
    this.reader = new ChangesFileReader({ path: cfg.path, agentIdHash: cfg.agentIdHash, start: "end" });
    this.now = cfg.now ?? Date.now;
    this.onError =
      cfg.onError ??
      ((err) => {
        throw err;
      });
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("ChangeFeedFollower.start() after close()");
    if (this.started) return;
    this.started = true;
    this.tracker.observeUnreadable();
    await this.pull();
    if (this.cfg.timer !== false) {
      this.timer = setInterval(() => {
        this.pull().catch((err) => this.onError(err));
      }, this.cfg.pollMs ?? DEFAULT_CHANGE_FEED_POLL_MS);
      this.timer.unref();
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  settled(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  erasureProgress(point: { readonly ino: number; readonly offset: number }): void {
    this.tracker.erasureFeedConsumed({ ino: point.ino, bytes: point.offset });
  }

  erased(cellId: string): void {
    this.tracker.erased(cellId);
  }

  noteOwnWrite(receipt: { readonly cellId: string; readonly seq?: string; readonly commitment?: string }): void {
    if (receipt.seq === undefined || receipt.commitment === undefined) return;
    const cur = this.ownWrites.get(receipt.cellId);
    if (cur !== undefined && heldCovers({ seq: receipt.seq, commitment: receipt.commitment }, cur) && cur.seq !== receipt.seq) return;
    this.ownWrites.set(receipt.cellId, { seq: receipt.seq, commitment: receipt.commitment });
  }

  appliedCursor(): string | null {
    return this.tracker.appliedCursor();
  }

  get status(): ChangeFeedFollowerStatus {
    const owed = this.tracker.owed();
    return {
      path: this.cfg.path,
      position: this.reader.position,
      tracker: this.tracker.status(),
      owedRefetch: owed.refetch.length,
      reconcileOwed: owed.reconcile !== null,
      liveness: this.liveness,
      ...this.counters,
    };
  }

  pull(): Promise<void> {
    const p = this.chain.then(() => this.run());
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  private async run(): Promise<void> {
    if (this.closed) return;
    this.counters.pulls++;
    const read = await this.reader.read();
    const feedNow = await erasureFeedPoint(this.cfg.erasurePath);
    applyChangesRead(this.tracker, read, feedNow);
    await this.applyOwedWrites();
    await this.maybeReconcile();
    this.liveness = await this.readLiveness();
  }

  private async applyOwedWrites(): Promise<void> {
    for (const w of this.tracker.owed().refetch) {
      const echo = heldCovers(w, this.ownWrites.get(w.cellId));
      const version = { seq: w.seq, commitment: w.commitment };
      try {
        await this.hooks.invalidate(w.cellId, version);
        if (!echo) await this.hooks.onChanged?.(w.cellId, version);
      } catch (err) {
        this.counters.hookFailures++;
        this.onError(err);
        continue;
      }
      if (echo) this.counters.echoesSkipped++;
      else this.counters.applied++;
      this.tracker.appliedWrite(w.cellId, w.seq);
    }
  }

  private async maybeReconcile(): Promise<void> {
    const ticket = this.tracker.owed().reconcile;
    if (ticket === null || this.hooks.reconcileByListing === undefined) return;
    const t = this.now();
    if (this.lastReconcileAttempt !== null && t - this.lastReconcileAttempt < (this.cfg.reconcileRetryMs ?? DEFAULT_RECONCILE_RETRY_MS)) return;
    this.lastReconcileAttempt = t;
    this.counters.reconcileAttempts++;
    let complete: boolean;
    try {
      complete = await this.hooks.reconcileByListing();
    } catch (err) {
      this.counters.hookFailures++;
      this.onError(err);
      return;
    }
    if (!complete) return;
    this.counters.reconcileCompleted++;
    this.tracker.reconciled(ticket);
  }

  private async readLiveness(): Promise<FeedLiveness> {
    const path = this.cfg.shareStatesPath ?? join(dirname(this.cfg.path), SHARE_STATES_FILENAME);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return feedLiveness("absent", this.now(), this.cfg.livenessMs ?? DEFAULT_FEED_LIVENESS_MS);
      return feedLiveness("unreadable", this.now(), this.cfg.livenessMs ?? DEFAULT_FEED_LIVENESS_MS);
    }
    return feedLiveness(readHeartbeat(text), this.now(), this.cfg.livenessMs ?? DEFAULT_FEED_LIVENESS_MS);
  }
}

export async function erasureFeedPoint(path: string): Promise<FeedPoint | null> {
  for (const p of [path, `${path}.1`]) {
    try {
      const st = await stat(p);
      return { ino: st.ino, bytes: st.size };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return null;
}

export function readHeartbeat(text: string): FeedHeartbeat | "unreadable" {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return "unreadable";
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return "unreadable";
  const d = doc as Record<string, unknown>;
  if (d["v"] !== 1) return "unreadable";
  const asOf = d["asOf"];
  let asOfMs: number | null = null;
  if (asOf !== null && asOf !== undefined) {
    if (typeof asOf !== "string" || !ISO_UTC.test(asOf)) return "unreadable";
    const t = Date.parse(asOf);
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 19) !== asOf.slice(0, 19)) return "unreadable";
    asOfMs = t;
  }
  const stopped = d["stopped"];
  if (stopped !== null && stopped !== undefined && (typeof stopped !== "string" || stopped === "")) return "unreadable";
  return { asOfMs, stopped: typeof stopped === "string" ? stopped : null };
}
