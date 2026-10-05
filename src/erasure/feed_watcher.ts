import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import { writeFileAtomic } from "../store/atomic_write.js";
import { assertStateDir, ensureStateDir } from "../store/state_dir.js";
import { basename, dirname, isAbsolute, join } from "node:path";

export const FEED_VERSION = 1 as const;
export const FEED_FILENAME = "erasures.ndjson";
export const FEED_MAX_LINE_BYTES = 1024;
export const DEFAULT_FEED_POLL_MS = 1000;

export const HEX64 = /^[0-9a-f]{64}$/;
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface FeedLine {
  readonly v: 1;
  readonly cellId: string;
  readonly agentIdHash: string;
  readonly at: string;
  readonly atMs: number;
  readonly complete: boolean;
  readonly destructionAnchor?: string;
  readonly reason?: string;
  readonly source: string;
}

export type FeedFaultOutcome = "malformed" | "foreign";

export type FeedLineVerdict =
  | { readonly ok: true; readonly line: FeedLine }
  | { readonly ok: false; readonly outcome: FeedFaultOutcome; readonly reason: string };

const ERASURE_REASON = /^[a-z][a-z-]{0,63}$/;

export function parseFeedLine(raw: string, expectIdentity?: string): FeedLineVerdict {
  const bad = (reason: string): FeedLineVerdict => ({ ok: false, outcome: "malformed", reason });
  if (Buffer.byteLength(raw, "utf8") > FEED_MAX_LINE_BYTES) return bad(`line exceeds ${FEED_MAX_LINE_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bad("not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return bad("not a JSON object");
  const r = parsed as Record<string, unknown>;
  if (r["v"] !== FEED_VERSION) return bad(`v is not ${FEED_VERSION}`);
  const cellId = r["cellId"];
  if (typeof cellId !== "string" || cellId === "") return bad("cellId missing or empty");
  const agentIdHash = r["agentIdHash"];
  if (typeof agentIdHash !== "string" || !HEX64.test(agentIdHash)) return bad("agentIdHash is not a 64-hex hash");
  const at = r["at"];
  if (typeof at !== "string" || !ISO_UTC.test(at)) return bad("at is not an ISO-8601 UTC timestamp ending in Z (a bare epoch is refused: the unit would be a guess)");
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return bad("at does not parse as a date");
  const complete = r["complete"];
  if (typeof complete !== "boolean") return bad("complete is not a boolean");
  const anchor = r["destructionAnchor"];
  if (anchor !== undefined && anchor !== null && typeof anchor !== "string") return bad("destructionAnchor is not a string");
  if (complete && (typeof anchor !== "string" || anchor === "")) return bad("complete:true without a destructionAnchor — a key destruction with no evidence is not reported as complete");
  const source = r["source"];
  if (typeof source !== "string" || source === "") return bad("source missing or empty");
  const reason = r["reason"];
  if (expectIdentity !== undefined && agentIdHash !== expectIdentity) {
    return { ok: false, outcome: "foreign", reason: "the line carries another identity's agentIdHash — a foreign line in a per-identity feed is a wiring fault, not an erasure" };
  }
  return {
    ok: true,
    line: { v: 1, cellId, agentIdHash, at, atMs, complete, ...(typeof anchor === "string" && anchor !== "" ? { destructionAnchor: anchor } : {}), ...(typeof reason === "string" && ERASURE_REASON.test(reason) ? { reason } : {}), source },
  };
}

export function splitCompleteLines(chunk: Buffer): { readonly lines: readonly string[]; readonly consumedBytes: number } {
  const last = chunk.lastIndexOf(0x0a);
  if (last < 0) return { lines: [], consumedBytes: 0 };
  const text = chunk.subarray(0, last).toString("utf8");
  return { lines: text.split("\n").filter((l) => l.trim() !== ""), consumedBytes: last + 1 };
}

export interface ResolveFeedPathInput {
  readonly identity: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
}

export function resolveFeedPath(i: ResolveFeedPathInput): string {
  if (!HEX64.test(i.identity)) throw new Error("resolveFeedPath: identity must be a 64-hex agentIdHash");
  const set = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== "" ? v : undefined);
  const root = set(i.env["SAIHM_ERASURE_FEED_DIR"]) ?? set(i.env["SAIHM_HOME"]) ?? join(i.homeDir, ".saihm");
  if (!isAbsolute(root)) {
    throw new Error("resolveFeedPath: the feed root is not an absolute path (SAIHM_ERASURE_FEED_DIR, SAIHM_HOME or the home directory) — the SAIHM client refuses a relative root and writes nothing there; set an absolute one, or pass the feed path explicitly");
  }
  return join(root, "tenants", i.identity, FEED_FILENAME);
}

export interface FeedCursor {
  readonly offset: number;
  readonly ino: number | null;
  readonly head?: FeedHead;
}

export interface FeedHead {
  readonly len: number;
  readonly sha256: string;
}

export async function readFeedHead(fh: FileHandle): Promise<FeedHead | null> {
  const buf = Buffer.alloc(FEED_MAX_LINE_BYTES + 1);
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
  const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
  if (nl < 0) return null;
  return { len: nl + 1, sha256: createHash("sha256").update(buf.subarray(0, nl + 1)).digest("hex") };
}

export async function feedHeadMatches(fh: FileHandle, head: FeedHead): Promise<boolean> {
  const buf = Buffer.alloc(head.len);
  const { bytesRead } = await fh.read(buf, 0, head.len, 0);
  return bytesRead === head.len && createHash("sha256").update(buf).digest("hex") === head.sha256;
}

const isFeedHead = (h: unknown): h is FeedHead =>
  typeof h === "object" && h !== null && Number.isInteger((h as FeedHead).len) && (h as FeedHead).len > 0 && (h as FeedHead).len <= FEED_MAX_LINE_BYTES + 1 &&
  typeof (h as FeedHead).sha256 === "string" && HEX64.test((h as FeedHead).sha256);

export interface FeedCursorStore {
  load(): Promise<FeedCursor | undefined>;
  save(cursor: FeedCursor): Promise<void>;
}

export class MemoryFeedCursorStore implements FeedCursorStore {
  private cursor: FeedCursor | undefined;
  async load(): Promise<FeedCursor | undefined> {
    return this.cursor;
  }
  async save(cursor: FeedCursor): Promise<void> {
    this.cursor = cursor;
  }
}

export class FileFeedCursorStore implements FeedCursorStore {
  constructor(readonly path: string) {
    assertStateDir("FileFeedCursorStore", dirname(path));
  }

  async load(): Promise<FeedCursor | undefined> {
    assertStateDir("FileFeedCursorStore", dirname(this.path));
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    try {
      const o = JSON.parse(text) as { offset?: unknown; ino?: unknown; head?: unknown };
      if (Number.isInteger(o.offset) && (o.offset as number) >= 0 && (o.ino === null || Number.isInteger(o.ino))) {
        return { offset: o.offset as number, ino: o.ino as number | null, ...(isFeedHead(o.head) ? { head: { len: o.head.len, sha256: o.head.sha256 } } : {}) };
      }
    } catch {
    }
    return undefined;
  }

  async save(cursor: FeedCursor): Promise<void> {
    await ensureStateDir("FileFeedCursorStore", dirname(this.path));
    await writeFileAtomic(this.path, JSON.stringify(cursor));
  }
}

export interface FeedConsumed {
  readonly line: FeedLine;
  readonly lagMs: number;
}

export interface FeedFault {
  readonly outcome: FeedFaultOutcome;
  readonly reason: string;
}

export interface FeedSink {
  consume(batch: readonly FeedConsumed[]): Promise<void>;
  fault?(fault: FeedFault): void;
  progressed?(point: { readonly ino: number; readonly offset: number }): void;
}

export interface FeedWatcherConfig {
  readonly path: string;
  readonly agentIdHash?: string;
  readonly cursor?: FeedCursorStore;
  readonly pollMs?: number;
  readonly onError?: (err: unknown) => void;
  readonly now?: () => number;
  readonly watch?: boolean;
}

export interface FeedWatcherStatus {
  readonly path: string;
  readonly identity: string | undefined;
  readonly armed: "watch" | "poll" | "idle";
  readonly cursorPersisted: boolean;
  readonly offset: number;
  readonly present: boolean;
  readonly consumed: number;
  readonly complete: number;
  readonly incomplete: number;
  readonly malformed: number;
  readonly foreign: number;
  readonly replays: number;
  readonly predecessorDrained: number;
  readonly predecessorLost: number;
  readonly predecessorPartial: number;
  readonly inodeReused: number;
  readonly runs: number;
}

export class FeedWatcher {
  private cursor: FeedCursor = { offset: 0, ino: null };
  private fsw: FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private started = false;
  private loaded = false;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private queued = false;
  private present = false;
  private readonly counters = { consumed: 0, complete: 0, incomplete: 0, malformed: 0, foreign: 0, replays: 0, predecessorDrained: 0, predecessorLost: 0, predecessorPartial: 0, inodeReused: 0, runs: 0 };
  private readonly pollMs: number;
  private readonly onError: (err: unknown) => void;
  private readonly now: () => number;

  constructor(
    private readonly cfg: FeedWatcherConfig,
    private readonly sink: FeedSink,
  ) {
    if (cfg.agentIdHash !== undefined && !HEX64.test(cfg.agentIdHash)) throw new Error("FeedWatcher: agentIdHash must be a 64-hex agentIdHash");
    this.pollMs = Number.isFinite(cfg.pollMs) && (cfg.pollMs as number) >= 1 ? (cfg.pollMs as number) : DEFAULT_FEED_POLL_MS;
    this.onError =
      cfg.onError ??
      ((err) => {
        throw err;
      });
    this.now = cfg.now ?? Date.now;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const loaded = await this.cfg.cursor?.load();
    if (loaded !== undefined) this.cursor = loaded;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("FeedWatcher.start() after close()");
    if (this.started) return;
    this.started = true;
    await this.load();
    await this.runOnce();
    this.armWatch();
    this.pollTimer = setInterval(() => {
      this.armWatch();
      this.schedule();
    }, this.pollMs);
    this.pollTimer.unref();
  }

  close(): void {
    this.closed = true;
    this.fsw?.close();
    this.fsw = undefined;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  settled(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  get status(): FeedWatcherStatus {
    return {
      path: this.cfg.path,
      identity: this.cfg.agentIdHash,
      armed: this.closed || !this.started ? "idle" : this.fsw !== undefined ? "watch" : "poll",
      cursorPersisted: this.cfg.cursor !== undefined && !(this.cfg.cursor instanceof MemoryFeedCursorStore),
      offset: this.cursor.offset,
      present: this.present,
      ...this.counters,
    };
  }

  runOnce(): Promise<number> {
    const before = this.counters.consumed;
    const p = this.chain.then(() => this.run()).then(() => this.counters.consumed - before);
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  async consumedLines(): Promise<readonly FeedLine[]> {
    if (this.cursor.offset === 0) return [];
    let fh;
    try {
      fh = await open(this.cfg.path, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    try {
      const buf = Buffer.alloc(this.cursor.offset);
      const { bytesRead } = await fh.read(buf, 0, this.cursor.offset, 0);
      const { lines } = splitCompleteLines(buf.subarray(0, bytesRead));
      const out: FeedLine[] = [];
      for (const raw of lines) {
        const v = parseFeedLine(raw, this.cfg.agentIdHash);
        if (v.ok) out.push(v.line);
      }
      return out;
    } finally {
      await fh.close();
    }
  }

  private armWatch(): void {
    if (this.closed || this.fsw !== undefined || this.cfg.watch === false) return;
    try {
      const w = watch(dirname(this.cfg.path), (_event, changed) => {
        if (changed === null || changed === basename(this.cfg.path)) this.schedule();
      });
      w.on("error", (err) => {
        this.fsw = undefined;
        try {
          w.close();
        } catch {
        }
        this.onError(err);
      });
      this.fsw = w;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.onError(e);
    }
  }

  private schedule(): void {
    if (this.closed || this.queued) return;
    this.queued = true;
    const p = this.chain.then(() => {
      this.queued = false;
      return this.run();
    });
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    void p.catch((err) => this.onError(err));
  }

  private async run(): Promise<number> {
    if (this.closed) return 0;
    this.counters.runs++;
    let st;
    try {
      st = await stat(this.cfg.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.present = false;
        if (this.cursor.ino === null) return 0;
        const n = await this.drainPredecessor(this.cursor.ino, true);
        if (this.cursor.ino !== null) this.sink.progressed?.({ ino: this.cursor.ino, offset: this.cursor.offset });
        return n;
      }
      throw e;
    }
    this.present = true;
    let drained = 0;
    const reused = this.cursor.ino !== null && st.ino === this.cursor.ino && this.cursor.head !== undefined && !(await this.headMatches(this.cfg.path, st.ino, this.cursor.head));
    if (reused) {
      this.counters.inodeReused++;
      this.counters.predecessorLost++;
    } else if (this.cursor.ino !== null && st.ino !== this.cursor.ino) {
      drained = await this.drainPredecessor(this.cursor.ino);
    }
    if (reused || (this.cursor.ino !== null && st.ino !== this.cursor.ino) || st.size < this.cursor.offset) {
      this.cursor = { offset: 0, ino: st.ino };
      this.counters.replays++;
    }
    const n = st.size > this.cursor.offset ? await this.consumeFrom(this.cfg.path, st.ino, this.cursor.offset, st.size, false) : 0;
    if (this.cursor.ino === null) this.cursor = { offset: 0, ino: st.ino };
    this.sink.progressed?.({ ino: this.cursor.ino!, offset: this.cursor.offset });
    return drained + n;
  }

  private async drainPredecessor(ino: number, whileAbsent = false): Promise<number> {
    const pred = `${this.cfg.path}.1`;
    let st;
    try {
      st = await stat(pred);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      st = undefined;
    }
    const head = this.cursor.head;
    if (st === undefined || st.ino !== ino || !st.isFile() || (head !== undefined && !(await this.headMatches(pred, ino, head)))) {
      if (!whileAbsent) this.counters.predecessorLost++;
      return 0;
    }
    if (!whileAbsent) this.counters.predecessorDrained++;
    if (st.size <= this.cursor.offset) return 0;
    return this.consumeFrom(pred, ino, this.cursor.offset, st.size, !whileAbsent);
  }

  private async headMatches(path: string, ino: number, head: FeedHead): Promise<boolean> {
    let fh;
    try {
      fh = await open(path, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    try {
      return (await fh.stat()).ino === ino && (await feedHeadMatches(fh, head));
    } finally {
      await fh.close();
    }
  }

  private async consumeFrom(path: string, ino: number, from: number, to: number, final: boolean): Promise<number> {
    const len = to - from;
    let head: FeedHead | undefined;
    let buf = Buffer.alloc(len);
    const fh = await open(path, "r");
    try {
      const fst = await fh.stat();
      if (fst.ino !== ino) {
        if (final) this.counters.predecessorLost++;
        return 0;
      }
      const { bytesRead } = await fh.read(buf, 0, len, from);
      buf = buf.subarray(0, bytesRead);
      if (from === 0 || this.cursor.ino !== ino || this.cursor.head === undefined) head = (await readFeedHead(fh)) ?? undefined;
      else head = this.cursor.head;
    } finally {
      await fh.close();
    }
    const { lines, consumedBytes } = splitCompleteLines(buf);
    if (final && consumedBytes < buf.length) this.counters.predecessorPartial++;
    if (consumedBytes === 0) return 0;
    const batch: FeedConsumed[] = [];
    const faults: FeedFault[] = [];
    const now = this.now();
    for (const raw of lines) {
      const v = parseFeedLine(raw, this.cfg.agentIdHash);
      if (v.ok) batch.push({ line: v.line, lagMs: Math.max(0, now - v.line.atMs) });
      else faults.push({ outcome: v.outcome, reason: v.reason });
    }
    if (batch.length > 0) await this.sink.consume(batch);
    this.cursor = { offset: from + consumedBytes, ino, ...(head !== undefined ? { head } : {}) };
    this.counters.consumed += batch.length;
    for (const b of batch) {
      if (b.line.complete) this.counters.complete++;
      else this.counters.incomplete++;
    }
    for (const f of faults) {
      if (f.outcome === "foreign") this.counters.foreign++;
      else this.counters.malformed++;
      this.sink.fault?.(f);
    }
    if (this.cfg.cursor !== undefined) await this.cfg.cursor.save(this.cursor);
    this.sink.progressed?.({ ino: this.cursor.ino!, offset: this.cursor.offset });
    return batch.length;
  }
}
