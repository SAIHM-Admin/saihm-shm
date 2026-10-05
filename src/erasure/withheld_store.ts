import { open, readFile, rename, unlink } from "node:fs/promises";
import { writeFileAtomic } from "../store/atomic_write.js";
import { assertStateDir, ensureStateDir } from "../store/state_dir.js";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export const WITHHELD_FILE_VERSION = 1;

export interface WithheldStore {
  load(): Promise<readonly string[] | undefined>;
  save(cellIds: readonly string[]): Promise<void>;
  quarantine?(): Promise<string | undefined>;
}

export class MemoryWithheldStore implements WithheldStore {
  private ids: readonly string[] | undefined;
  async quarantine(): Promise<string | undefined> {
    return undefined;
  }
  async load(): Promise<readonly string[] | undefined> {
    return this.ids;
  }
  async save(cellIds: readonly string[]): Promise<void> {
    this.ids = [...cellIds];
  }
}

export class WithheldStoreCorruptError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`withheld store ${path}: ${detail}`);
    this.name = "WithheldStoreCorruptError";
  }
}

export interface FileWithheldStoreOptions {
  readonly owner?: string;
}

export class FileWithheldStore implements WithheldStore {
  lastLoadedOwner: string | null | undefined;

  constructor(readonly path: string, readonly opts: FileWithheldStoreOptions = {}) {
    assertStateDir("FileWithheldStore", dirname(path));
  }

  async probeWritable(): Promise<void> {
    await ensureStateDir("FileWithheldStore", dirname(this.path));
    const probe = `${this.path}.probe.${process.pid}.${randomBytes(6).toString("hex")}`;
    const fh = await open(probe, "wx", 0o600);
    await fh.close();
    await unlink(probe);
  }

  async load(): Promise<readonly string[] | undefined> {
    assertStateDir("FileWithheldStore", dirname(this.path));
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.lastLoadedOwner = null;
        return undefined;
      }
      throw new WithheldStoreCorruptError(this.path, `unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
    let o: unknown;
    try {
      o = JSON.parse(text);
    } catch {
      throw new WithheldStoreCorruptError(this.path, "not JSON");
    }
    if (typeof o !== "object" || o === null) throw new WithheldStoreCorruptError(this.path, "not an object");
    const { v, withheld, owner } = o as { v?: unknown; withheld?: unknown; owner?: unknown };
    if (v !== WITHHELD_FILE_VERSION) throw new WithheldStoreCorruptError(this.path, `version ${String(v)} is not ${WITHHELD_FILE_VERSION}`);
    if (!Array.isArray(withheld) || !withheld.every((x) => typeof x === "string" && x.length > 0)) {
      throw new WithheldStoreCorruptError(this.path, "`withheld` is not a list of non-empty ids");
    }
    this.lastLoadedOwner = typeof owner === "string" && owner.length > 0 ? owner : null;
    return [...new Set(withheld as string[])].sort();
  }

  async quarantine(): Promise<string | undefined> {
    const to = `${this.path}.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(this.path, to);
      return to;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  async save(cellIds: readonly string[]): Promise<void> {
    await ensureStateDir("FileWithheldStore", dirname(this.path));
    await writeFileAtomic(this.path, JSON.stringify({ v: WITHHELD_FILE_VERSION, withheld: [...new Set(cellIds)].sort(), ...(this.opts.owner !== undefined ? { owner: this.opts.owner } : {}) }));
  }
}
