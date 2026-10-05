import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { chmod, readdir, readFile, rm, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { TEMP_NAME_OVERHEAD_MAX, writeFileAtomic } from "./atomic_write.js";
import { requireDir } from "./require_dir.js";
import { assertStateDir, ensureStateDir } from "./state_dir.js";
import { join } from "node:path";

const MAGIC = Buffer.from("SHMB", "ascii");
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MAX_HEADER_LEN = 64 * 1024;

export function normalizeEpoch(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v + 0 : 0;
}

export function normalizeTier(v: unknown): string {
  return typeof v === "string" ? v : "unknown";
}
const CELL_ID_RE = /^[0-9a-f]{1,128}$/i;
const SUFFIX = ".body.enc";
const ENCODED_PREFIX = "x-";
const ENCODED_STEM_RE = /^x-((?:[0-9a-f]{2})+)$/;
const NAME_MAX = 255;
const MAX_NAME_LEN = NAME_MAX - TEMP_NAME_OVERHEAD_MAX;

function nameFor(cellId: string): string | undefined {
  if (CELL_ID_RE.test(cellId)) return `${cellId}${SUFFIX}`;
  if (cellId === "") return undefined;
  const bytes = Buffer.from(cellId, "utf8");
  if (bytes.toString("utf8") !== cellId) return undefined;
  const name = `${ENCODED_PREFIX}${bytes.toString("hex")}${SUFFIX}`;
  return name.length <= MAX_NAME_LEN ? name : undefined;
}

function idOfName(name: string): string | undefined {
  if (!name.endsWith(SUFFIX)) return undefined;
  const stem = name.slice(0, -SUFFIX.length);
  if (CELL_ID_RE.test(stem)) return stem;
  const m = ENCODED_STEM_RE.exec(stem);
  if (m === null) return undefined;
  const id = Buffer.from(m[1]!, "hex").toString("utf8");
  return nameFor(id) === name ? id : undefined;
}

export interface BodyRecord {
  readonly cellId: string;
  readonly plaintext: string;
  readonly epoch: number;
  readonly tier: string;
}

export interface BodyStore {
  get(cellId: string): Promise<BodyRecord | undefined>;
  put(body: BodyRecord): Promise<void>;
  delete(cellId: string): Promise<void>;
  has(cellId: string): Promise<boolean>;
  accepts?(cellId: string): boolean;
}

interface BodyHeader {
  readonly formatVersion: 1;
  readonly tenantId: string;
  readonly cellId: string;
  readonly epoch: number;
  readonly tier: string;
}

export interface EncryptedBodyStoreConfig {
  readonly dir: string;
  readonly tenantId?: string;
  readonly keyBytes?: Uint8Array;
}

export type AtRestPresence = "present" | "absent" | "unknown";

function presenceOfError(e: unknown): AtRestPresence {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
}

export class EncryptedBodyStore implements BodyStore {
  readonly tenantId: string;
  private readonly dir: string;
  private readonly injectedKey: Buffer | undefined;
  private cachedKey: Buffer | undefined;

  constructor(cfg: EncryptedBodyStoreConfig) {
    this.dir = requireDir("EncryptedBodyStore", cfg.dir);
    assertStateDir("EncryptedBodyStore", this.dir);
    this.tenantId = cfg.tenantId ?? "local";
    if (cfg.keyBytes !== undefined) {
      if (cfg.keyBytes.length !== KEY_LEN) {
        throw new Error(`keyBytes must be ${KEY_LEN} bytes, got ${cfg.keyBytes.length}`);
      }
      this.injectedKey = Buffer.from(cfg.keyBytes);
    }
  }

  get keyPath(): string {
    return join(this.dir, "body.key");
  }

  accepts(cellId: string): boolean {
    return this.filePathFor(cellId) !== undefined;
  }

  filePathFor(cellId: string): string | undefined {
    const name = nameFor(cellId);
    return name === undefined ? undefined : join(this.dir, name);
  }

  async get(cellId: string): Promise<BodyRecord | undefined> {
    assertStateDir("EncryptedBodyStore", this.dir);
    const path = this.filePathFor(cellId);
    if (path === undefined) return undefined;

    let file: Buffer;
    try {
      file = await readFile(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      return undefined;
    }

    if (file.length < MAGIC.length + 4) return undefined;
    if (!file.subarray(0, MAGIC.length).equals(MAGIC)) return undefined;
    const headerLen = file.readUInt32LE(MAGIC.length);
    if (headerLen === 0 || headerLen > MAX_HEADER_LEN) return undefined;
    const headerStart = MAGIC.length + 4;
    const ivStart = headerStart + headerLen;
    const ctStart = ivStart + IV_LEN + TAG_LEN;
    if (file.length < ctStart) return undefined;
    const headerBytes = file.subarray(headerStart, ivStart);
    const iv = file.subarray(ivStart, ivStart + IV_LEN);
    const tag = file.subarray(ivStart + IV_LEN, ctStart);
    const ciphertext = file.subarray(ctStart);

    let header: BodyHeader;
    try {
      header = JSON.parse(headerBytes.toString("utf8")) as BodyHeader;
    } catch {
      return undefined;
    }
    if (header.formatVersion !== 1) return undefined;
    if (header.tenantId !== this.tenantId) return undefined;
    if (header.cellId !== cellId) return undefined;

    const key = await this.getKey();
    let plaintextBuf: Buffer;
    try {
      const d = createDecipheriv("aes-256-gcm", key, iv);
      d.setAAD(headerBytes);
      d.setAuthTag(tag);
      plaintextBuf = Buffer.concat([d.update(ciphertext), d.final()]);
    } catch {
      return undefined;
    }

    return {
      cellId,
      plaintext: plaintextBuf.toString("utf8"),
      epoch: normalizeEpoch(header.epoch),
      tier: normalizeTier(header.tier),
    };
  }

  async put(body: BodyRecord): Promise<void> {
    const path = this.filePathFor(body.cellId);
    if (path === undefined) {
      throw new Error(`refusing to persist body: this store cannot hold cellId ${JSON.stringify(body.cellId)} (see accepts)`);
    }
    const key = await this.getKey();
    const header: BodyHeader = {
      formatVersion: 1,
      tenantId: this.tenantId,
      cellId: body.cellId,
      epoch: normalizeEpoch(body.epoch),
      tier: normalizeTier(body.tier),
    };
    const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    if (headerBytes.length > MAX_HEADER_LEN) {
      throw new Error(
        `refusing to persist body for ${body.cellId}: header is ${headerBytes.length} B, over the ${MAX_HEADER_LEN} B this store can read back`,
      );
    }

    const iv = randomBytes(IV_LEN);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(headerBytes);
    const ciphertext = Buffer.concat([c.update(Buffer.from(body.plaintext, "utf8")), c.final()]);
    const tag = c.getAuthTag();

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(headerBytes.length, 0);
    const out = Buffer.concat([MAGIC, lenBuf, headerBytes, iv, tag, ciphertext]);
    await this.atomicWrite(path, out);
  }

  async delete(cellId: string): Promise<void> {
    const path = this.filePathFor(cellId);
    if (path === undefined) return;
    await rm(path, { force: true });
  }

  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw e;
    }
    const out: string[] = [];
    for (const n of names) {
      const id = idOfName(n);
      if (id !== undefined) out.push(id);
    }
    return out;
  }

  async presence(cellId: string): Promise<AtRestPresence> {
    const path = this.filePathFor(cellId);
    if (path === undefined) return "absent";
    try {
      await stat(path);
      return "present";
    } catch (e) {
      return presenceOfError(e);
    }
  }
  presenceSync(cellId: string): AtRestPresence {
    const path = this.filePathFor(cellId);
    if (path === undefined) return "absent";
    try {
      statSync(path);
      return "present";
    } catch (e) {
      return presenceOfError(e);
    }
  }

  async has(cellId: string): Promise<boolean> {
    return (await this.presence(cellId)) === "present";
  }
  hasSync(cellId: string): boolean {
    return this.presenceSync(cellId) === "present";
  }

  private async getKey(): Promise<Buffer> {
    if (this.injectedKey) return this.injectedKey;
    if (this.cachedKey) return this.cachedKey;
    assertStateDir("EncryptedBodyStore", this.dir);
    try {
      const raw = await readFile(this.keyPath);
      if (raw.length !== KEY_LEN) {
        throw new Error(
          `corrupt body-store key ${this.keyPath} (${raw.length} bytes, want ${KEY_LEN}). ` +
            `The store is a rebuildable cache: delete ${this.dir} to reset.`,
        );
      }
      const st = await stat(this.keyPath);
      if ((st.mode & 0o077) !== 0) await chmod(this.keyPath, 0o600);
      this.cachedKey = raw;
      return raw;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
    const fresh = randomBytes(KEY_LEN);
    await this.atomicWrite(this.keyPath, fresh);
    this.cachedKey = fresh;
    return fresh;
  }

  private async atomicWrite(path: string, data: Buffer): Promise<void> {
    await ensureStateDir("EncryptedBodyStore", this.dir);
    await writeFileAtomic(path, data);
  }
}
