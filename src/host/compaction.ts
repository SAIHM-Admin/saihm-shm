import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, sep } from "node:path";
import { COMPACT_MARKER } from "../inject/population.js";

export interface TranscriptCompactionOptions {
  readonly root?: string;
  readonly maxTracked?: number;
  readonly marker?: string;
}

export type CompactCountOf = (transcriptPath: string | undefined, sessionId: string | undefined) => number | undefined;

export class TranscriptCompactionCounter {
  private readonly root: string;
  private readonly maxTracked: number;
  private readonly marker: string;
  private readonly cache = new Map<string, { ino: number; size: number; count: number; tail: string }>();

  constructor(opts: TranscriptCompactionOptions = {}) {
    this.root = opts.root ?? `${homedir()}${sep}.claude`;
    this.maxTracked = Number.isInteger(opts.maxTracked) && (opts.maxTracked as number) > 0 ? (opts.maxTracked as number) : 16;
    this.marker = typeof opts.marker === "string" && opts.marker !== "" ? opts.marker : COMPACT_MARKER;
  }

  count(transcriptPath: string | undefined, sessionId: string | undefined): number | undefined {
    try {
      if (typeof transcriptPath !== "string" || typeof sessionId !== "string" || sessionId === "") return undefined;
      if (!isAbsolute(transcriptPath) || basename(transcriptPath) !== `${sessionId}.jsonl`) return undefined;
      const real = realpathSync(transcriptPath);
      const rootReal = realpathSync(this.root);
      if (!real.startsWith(rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`)) return undefined;
      const st = statSync(real);
      if (!st.isFile()) return undefined;
      const size = st.size;
      const hit = this.cache.get(real);
      let scan: { count: number; tail: string };
      const same = hit !== undefined && hit.ino === st.ino;
      if (same && hit.size === size) {
        scan = { count: hit.count, tail: hit.tail };
      } else if (same && size > hit.size) {
        const more = this.countIn(real, hit.size, size, hit.tail);
        scan = { count: hit.count + more.count, tail: more.tail };
      } else {
        scan = this.countIn(real, 0, size, "");
      }
      const count = scan.count;
      this.cache.delete(real);
      this.cache.set(real, { ino: st.ino, size, count, tail: scan.tail });
      while (this.cache.size > this.maxTracked) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return count;
    } catch {
      return undefined;
    }
  }

  private countIn(path: string, from: number, to: number, carry: string): { count: number; tail: string } {
    if (to <= from) return { count: 0, tail: carry };
    const fd = openSync(path, "r");
    try {
      const CHUNK = 1 << 20;
      const keep = this.marker.length - 1;
      let count = 0;
      let pos = from;
      let tail = carry;
      while (pos < to) {
        const len = Math.min(CHUNK, to - pos);
        const buf = Buffer.allocUnsafe(len);
        const read = readSync(fd, buf, 0, len, pos);
        if (read <= 0) break;
        const text = tail + buf.subarray(0, read).toString("latin1");
        let at = 0;
        for (let i = text.indexOf(this.marker); i !== -1; i = text.indexOf(this.marker, at)) {
          count++;
          at = i + this.marker.length;
        }
        tail = text.slice(Math.max(at, text.length - keep));
        pos += read;
      }
      return { count, tail };
    } finally {
      closeSync(fd);
    }
  }
}
