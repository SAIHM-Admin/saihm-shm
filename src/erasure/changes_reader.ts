import { open, stat } from "node:fs/promises";
import { parseChangesLine, type ChangesLine, type ChangesTracker, type FeedPoint } from "./changes_feed.js";
import { FEED_MAX_LINE_BYTES, HEX64, feedHeadMatches, readFeedHead, splitCompleteLines, type FeedHead } from "./feed_watcher.js";

export interface ChangesPosition {
  readonly ino: number | null;
  readonly offset: number;
  readonly head?: FeedHead;
}

export type ChangesItem =
  | { readonly kind: "line"; readonly line: ChangesLine }
  | { readonly kind: "unreadable"; readonly outcome: "malformed" | "foreign" | "lost"; readonly reason: string }
  | { readonly kind: "ignored" };

export interface ChangesRead {
  readonly items: readonly ChangesItem[];
  readonly position: ChangesPosition;
}

export interface ChangesReaderConfig {
  readonly path: string;
  readonly agentIdHash: string;
  readonly start?: ChangesPosition | "end";
}

const START: ChangesPosition = { ino: null, offset: 0 };

export class ChangesFileReader {
  private pos: ChangesPosition = START;
  private pendingStart: "end" | null = null;

  constructor(private readonly cfg: ChangesReaderConfig) {
    if (!HEX64.test(cfg.agentIdHash)) throw new Error("ChangesFileReader: agentIdHash must be a 64-hex agentIdHash");
    if (cfg.start === "end") this.pendingStart = "end";
    else if (cfg.start !== undefined) this.pos = cfg.start;
  }

  get position(): ChangesPosition {
    return this.pos;
  }

  async read(): Promise<ChangesRead> {
    let st;
    try {
      st = await stat(this.cfg.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      st = undefined;
    }
    if (this.pendingStart === "end") {
      this.pendingStart = null;
      if (st === undefined) return { items: [], position: (this.pos = START) };
      const head = await this.headOf(this.cfg.path, st.ino);
      this.pos = { ino: st.ino, offset: st.size, ...(head !== undefined ? { head } : {}) };
      return { items: [], position: this.pos };
    }
    const items: ChangesItem[] = [];
    if (st === undefined) {
      if (this.pos.ino !== null) {
        const drained = await this.drainPredecessor(this.pos.ino, items);
        if (!drained) items.push(lost("the change feed vanished and its predecessor is not the file being read"));
        this.pos = START;
      }
      return { items, position: this.pos };
    }
    if (this.pos.ino !== null) {
      const reused = st.ino === this.pos.ino && this.pos.head !== undefined && !(await this.headMatches(this.cfg.path, st.ino, this.pos.head));
      if (reused) {
        items.push(lost("the file has this reader's inode number but another first line: the file being read is gone"));
        this.pos = { ino: st.ino, offset: 0 };
      } else if (st.ino !== this.pos.ino) {
        const drained = await this.drainPredecessor(this.pos.ino, items);
        if (!drained) items.push(lost("rotated, and the predecessor is not the file being read: its unread lines are gone"));
        this.pos = { ino: st.ino, offset: 0 };
      } else if (st.size < this.pos.offset) {
        items.push(lost("the file shrank: lines were rewritten or truncated in place"));
        this.pos = { ino: st.ino, offset: 0 };
      }
    } else {
      this.pos = { ino: st.ino, offset: 0 };
    }
    if (st.size > this.pos.offset) await this.consume(this.cfg.path, st.ino, this.pos.offset, st.size, false, items);
    return { items, position: this.pos };
  }

  private async drainPredecessor(ino: number, items: ChangesItem[]): Promise<boolean> {
    const pred = `${this.cfg.path}.1`;
    let st;
    try {
      st = await stat(pred);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    if (st.ino !== ino || !st.isFile()) return false;
    if (this.pos.head !== undefined && !(await this.headMatches(pred, ino, this.pos.head))) return false;
    if (st.size > this.pos.offset) {
      const ok = await this.consume(pred, ino, this.pos.offset, st.size, true, items);
      if (!ok) return false;
    }
    return true;
  }

  private async consume(path: string, ino: number, from: number, to: number, final: boolean, items: ChangesItem[]): Promise<boolean> {
    let buf = Buffer.alloc(to - from);
    let head: FeedHead | undefined;
    const fh = await open(path, "r");
    try {
      if ((await fh.stat()).ino !== ino) return false;
      const { bytesRead } = await fh.read(buf, 0, buf.length, from);
      buf = buf.subarray(0, bytesRead);
      head = from === 0 || this.pos.ino !== ino || this.pos.head === undefined ? ((await readFeedHead(fh)) ?? undefined) : this.pos.head;
    } finally {
      await fh.close();
    }
    const { lines, consumedBytes } = splitCompleteLines(buf);
    for (const raw of lines) {
      const v = parseChangesLine(raw, this.cfg.agentIdHash);
      if (v.ok) items.push({ kind: "line", line: v.line });
      else if (v.outcome === "ignored") items.push({ kind: "ignored" });
      else items.push({ kind: "unreadable", outcome: v.outcome, reason: v.reason });
    }
    if (final && consumedBytes < buf.length) {
      items.push(lost(buf.length - consumedBytes > FEED_MAX_LINE_BYTES ? "an over-long unterminated line was left in the predecessor" : "a partial last line was left in the predecessor"));
      this.pos = { ino, offset: from + buf.length, ...(head !== undefined ? { head } : {}) };
      return true;
    }
    this.pos = { ino, offset: from + consumedBytes, ...(head !== undefined ? { head } : {}) };
    return true;
  }

  private async headOf(path: string, ino: number): Promise<FeedHead | undefined> {
    let fh;
    try {
      fh = await open(path, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    try {
      if ((await fh.stat()).ino !== ino) return undefined;
      return (await readFeedHead(fh)) ?? undefined;
    } finally {
      await fh.close();
    }
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
}

function lost(reason: string): ChangesItem {
  return { kind: "unreadable", outcome: "lost", reason };
}

export function applyChangesRead(tracker: ChangesTracker, read: ChangesRead, feedNow: FeedPoint | null): { readonly lines: number; readonly unreadable: number; readonly ignored: number } {
  let lines = 0, unreadable = 0, ignored = 0;
  for (const it of read.items) {
    if (it.kind === "line") {
      tracker.observe(it.line, feedNow);
      lines++;
    } else if (it.kind === "unreadable") {
      tracker.observeUnreadable();
      unreadable++;
    } else {
      ignored++;
    }
  }
  return { lines, unreadable, ignored };
}
