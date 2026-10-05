import { open, readFile, realpath, unlink } from "node:fs/promises";
import { writeFileAtomic } from "./atomic_write.js";
import { ensureStateDir } from "./state_dir.js";
import { readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const WRITER_LOCK_FILENAME = ".shm-writer.lock";

export interface WriterLockHolder {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly nonce: string;
  readonly owner?: string;
}

export type WriterLockRefusal = "held" | "held-in-process" | "foreign-host" | "unreadable" | "lost-race";

export class StoreLockedError extends Error {
  constructor(
    readonly path: string,
    readonly why: WriterLockRefusal,
    readonly holder: WriterLockHolder | undefined,
    detail: string,
  ) {
    super(`store is locked (${why}): ${path} — ${detail}`);
    this.name = "StoreLockedError";
  }
}

export interface WriterLock {
  readonly path: string;
  readonly dir: string;
  readonly holder: WriterLockHolder;
  readonly sharedInProcess: number;
  readonly newestInProcess: boolean;
  release(): Promise<void>;
}

export interface WriterLockOptions {
  readonly host?: string;
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
  readonly owner?: string;
}

interface Registry {
  readonly holder: WriterLockHolder;
  count: number;
  readonly live: Set<number>;
  nextGeneration: number;
}

const registry = new Map<string, Registry>();
let exitHookArmed = false;

function armExitHook(): void {
  if (exitHookArmed) return;
  exitHookArmed = true;
  process.once("exit", () => {
    for (const [path, r] of registry) {
      try {
        const on = parseHolder(readFileSync(path, "utf8"));
        if (on !== undefined && on.nonce === r.holder.nonce) unlinkSync(path);
      } catch {
      }
    }
  });
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseHolder(text: string): WriterLockHolder | undefined {
  try {
    const o = JSON.parse(text) as Partial<WriterLockHolder>;
    if (
      Number.isInteger(o.pid) && (o.pid as number) > 0 &&
      typeof o.host === "string" && o.host.length > 0 &&
      typeof o.startedAt === "string" && o.startedAt.length > 0 &&
      typeof o.nonce === "string" && o.nonce.length > 0 &&
      (o.owner === undefined || (typeof o.owner === "string" && o.owner.length > 0))
    ) {
      return { pid: o.pid as number, host: o.host, startedAt: o.startedAt, nonce: o.nonce, ...(o.owner !== undefined ? { owner: o.owner } : {}) };
    }
  } catch {
  }
  return undefined;
}

export async function canonicalLockDir(dir: string): Promise<string> {
  await ensureStateDir("writer lock", dir);
  return realpath(dir);
}

const describe = (h: WriterLockHolder, canonicalDir: string): string =>
  h.owner !== undefined && h.owner !== canonicalDir ? `one writer per state directory (it belongs to the index directory ${h.owner})` : "one session per index directory";

export async function acquireWriterLock(dir: string, opts: WriterLockOptions = {}): Promise<WriterLock> {
  const path = resolve(join(dir, WRITER_LOCK_FILENAME));
  const host = opts.host ?? hostname();
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidIsAlive;
  const real = await canonicalLockDir(dir);
  const key = join(real, WRITER_LOCK_FILENAME);

  const shared = registry.get(key);
  if (shared !== undefined) {
    const theirs = shared.holder.owner;
    if (opts.owner !== undefined && theirs !== undefined && opts.owner !== theirs) {
      throw new StoreLockedError(path, "held-in-process", shared.holder, `held by another session in this process (pid ${shared.holder.pid}) for the index directory ${theirs}; ${describe(shared.holder, real)}`);
    }
    shared.count++;
    return handle(key, path, real, shared);
  }

  const holder: WriterLockHolder = { pid, host, startedAt: (opts.now?.() ?? new Date()).toISOString(), nonce: randomBytes(8).toString("hex"), ...(opts.owner !== undefined ? { owner: opts.owner } : {}) };
  const body = JSON.stringify(holder);

  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(key, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let text: string;
    try {
      text = await readFile(key, "utf8");
    } catch (re) {
      throw new StoreLockedError(path, "unreadable", undefined, `the lock file exists but cannot be read (${re instanceof Error ? re.message : String(re)}); if no session runs on this directory, remove it by hand`);
    }
    const other = parseHolder(text);
    if (other === undefined) throw new StoreLockedError(path, "unreadable", undefined, "the lock file exists but is not a lock this build wrote; if no session runs on this directory, remove it by hand");
    if (other.host !== host) throw new StoreLockedError(path, "foreign-host", other, `held by pid ${other.pid} on host ${other.host} since ${other.startedAt}; liveness cannot be checked from ${host} — if that process is gone, remove the file by hand`);
    if (isAlive(other.pid)) {
      const self = other.pid === pid ? ` — this process's own pid, but not a lock this process holds: a previous run that reused the pid, or another pid namespace sharing this host name; if no session runs on this directory, remove the file by hand` : "";
      throw new StoreLockedError(path, "held", other, `held by pid ${other.pid} on this host since ${other.startedAt}${other.owner !== undefined ? ` for ${other.owner}` : ""}; ${describe(other, real)}${self}`);
    }
    await writeFileAtomic(key, body);
    const after = parseHolder(await readFile(key, "utf8").catch(() => ""));
    if (after === undefined || after.nonce !== holder.nonce) {
      throw new StoreLockedError(path, "lost-race", after, `a stale lock was replaced by another process at the same moment${after !== undefined ? ` (pid ${after.pid} on ${after.host})` : ""}`);
    }
    const r: Registry = { holder, count: 1, live: new Set(), nextGeneration: 0 };
    registry.set(key, r);
    armExitHook();
    return handle(key, path, real, r);
  }
  try {
    await fh.writeFile(body);
  } finally {
    await fh.close();
  }
  const r: Registry = { holder, count: 1, live: new Set(), nextGeneration: 0 };
  registry.set(key, r);
  armExitHook();
  return handle(key, path, real, r);
}

function handle(key: string, path: string, dir: string, r: Registry): WriterLock {
  let released = false;
  const generation = r.nextGeneration++;
  r.live.add(generation);
  return {
    path,
    dir,
    holder: r.holder,
    get sharedInProcess() {
      return r.count;
    },
    get newestInProcess() {
      if (released) return false;
      let newest = -1;
      for (const g of r.live) if (g > newest) newest = g;
      return generation === newest;
    },
    async release() {
      if (released) return;
      released = true;
      r.live.delete(generation);
      r.count--;
      if (r.count > 0) return;
      registry.delete(key);
      try {
        const on = parseHolder(await readFile(key, "utf8"));
        if (on !== undefined && on.nonce === r.holder.nonce) await unlink(key);
      } catch {
      }
    },
  };
}
