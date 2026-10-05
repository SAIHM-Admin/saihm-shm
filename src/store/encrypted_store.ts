import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { chmod, readFile, rm, stat } from "node:fs/promises";
import { writeFileAtomic } from "./atomic_write.js";
import { requireDir } from "./require_dir.js";
import { assertStateDir, ensureStateDir } from "./state_dir.js";
import { join } from "node:path";
import type { ExpectedSpace, LoadResult, PersistedRow, StoreHeader } from "./types.js";

const MAGIC = Buffer.from("SHM1", "ascii");
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MAX_HEADER_LEN = 64 * 1024;

export interface EncryptedIndexStoreConfig {
  readonly dir: string;
  readonly tenantId?: string;
  readonly keyBytes?: Uint8Array;
}

export class EncryptedIndexStore {
  readonly tenantId: string;
  readonly dir: string;
  private readonly injectedKey: Buffer | undefined;
  private cachedKey: Buffer | undefined;

  constructor(cfg: EncryptedIndexStoreConfig) {
    this.dir = requireDir("EncryptedIndexStore", cfg.dir);
    assertStateDir("EncryptedIndexStore", this.dir);
    this.tenantId = cfg.tenantId ?? "local";
    if (cfg.keyBytes !== undefined) {
      if (cfg.keyBytes.length !== KEY_LEN) {
        throw new Error(`keyBytes must be ${KEY_LEN} bytes, got ${cfg.keyBytes.length}`);
      }
      this.injectedKey = Buffer.from(cfg.keyBytes);
    }
  }

  get filePath(): string {
    return join(this.dir, "index.v1.enc");
  }

  get keyPath(): string {
    return join(this.dir, "index.key");
  }

  async load(expect: ExpectedSpace): Promise<LoadResult> {
    assertStateDir("EncryptedIndexStore", this.dir);
    let file: Buffer;
    try {
      file = await readFile(this.filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent" };
      return { state: "invalid", reason: `unreadable: ${String(e)}` };
    }

    if (file.length < MAGIC.length + 4) return { state: "invalid", reason: "truncated envelope" };
    if (!file.subarray(0, MAGIC.length).equals(MAGIC)) return { state: "invalid", reason: "bad magic" };
    const headerLen = file.readUInt32LE(MAGIC.length);
    if (headerLen === 0 || headerLen > MAX_HEADER_LEN) {
      return { state: "invalid", reason: `implausible header length ${headerLen}` };
    }
    const headerStart = MAGIC.length + 4;
    const ivStart = headerStart + headerLen;
    const ctStart = ivStart + IV_LEN + TAG_LEN;
    if (file.length < ctStart) return { state: "invalid", reason: "truncated header/iv/tag" };
    const headerBytes = file.subarray(headerStart, ivStart);
    const iv = file.subarray(ivStart, ivStart + IV_LEN);
    const tag = file.subarray(ivStart + IV_LEN, ctStart);
    const ciphertext = file.subarray(ctStart);

    let header: StoreHeader;
    try {
      header = JSON.parse(headerBytes.toString("utf8")) as StoreHeader;
    } catch {
      return { state: "invalid", reason: "header not JSON" };
    }
    if (header.formatVersion !== 1) {
      return { state: "invalid", reason: `unsupported formatVersion ${String(header.formatVersion)}` };
    }
    if (header.tenantId !== this.tenantId) {
      return { state: "invalid", reason: `tenant mismatch: file "${header.tenantId}" vs store "${this.tenantId}"` };
    }
    if (header.modelId !== expect.modelId || header.dim !== expect.dim) {
      return {
        state: "invalid",
        reason: `model space mismatch: file ${header.modelId}/${header.dim} vs live ${expect.modelId}/${expect.dim}`,
      };
    }
    if (!Number.isInteger(header.count) || header.count < 0) {
      return { state: "invalid", reason: "bad header count" };
    }

    const key = await this.getKey();
    let payload: Buffer;
    try {
      const d = createDecipheriv("aes-256-gcm", key, iv);
      d.setAAD(headerBytes);
      d.setAuthTag(tag);
      payload = Buffer.concat([d.update(ciphertext), d.final()]);
    } catch {
      return { state: "invalid", reason: "decryption/authentication failed (wrong key or tampered file)" };
    }

    const parsed = decodeRows(payload, header.dim);
    if (typeof parsed === "string") return { state: "invalid", reason: parsed };
    if (parsed.length !== header.count) {
      return { state: "invalid", reason: `row count ${parsed.length} != header count ${header.count}` };
    }
    return { state: "loaded", header, rows: parsed };
  }

  async save(rows: readonly PersistedRow[], space: ExpectedSpace): Promise<void> {
    const key = await this.getKey();
    const header: StoreHeader = {
      formatVersion: 1,
      modelId: space.modelId,
      dim: space.dim,
      count: rows.length,
      tenantId: this.tenantId,
      builtEpoch: Math.floor(Date.now() / 3_600_000),
    };
    const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    if (headerBytes.length > MAX_HEADER_LEN) {
      throw new Error(
        `refusing to persist index: header is ${headerBytes.length} B, over the ${MAX_HEADER_LEN} B this store can read back`,
      );
    }

    const payload = encodeRows(rows, space.dim);
    const iv = randomBytes(IV_LEN);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(headerBytes);
    const ciphertext = Buffer.concat([c.update(payload), c.final()]);
    const tag = c.getAuthTag();

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(headerBytes.length, 0);
    const out = Buffer.concat([MAGIC, lenBuf, headerBytes, iv, tag, ciphertext]);
    await this.atomicWrite(this.filePath, out);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  private async getKey(): Promise<Buffer> {
    if (this.injectedKey) return this.injectedKey;
    if (this.cachedKey) return this.cachedKey;
    assertStateDir("EncryptedIndexStore", this.dir);
    try {
      const raw = await readFile(this.keyPath);
      if (raw.length !== KEY_LEN) {
        throw new Error(
          `corrupt key file ${this.keyPath} (${raw.length} bytes, want ${KEY_LEN}). ` +
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
    await ensureStateDir("EncryptedIndexStore", this.dir);
    await writeFileAtomic(path, data);
  }
}

function encodeRows(rows: readonly PersistedRow[], dim: number): Buffer {
  const enc = new TextEncoder();
  const parts: Buffer[] = [];
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(rows.length, 0);
  parts.push(countBuf);
  for (const r of rows) {
    if (r.vec.length !== dim) {
      throw new Error(`row ${r.cellId}: vec dim ${r.vec.length} != ${dim} (fail-closed)`);
    }
    const idBytes = enc.encode(r.cellId);
    if (idBytes.length === 0 || idBytes.length > 0xffff) {
      throw new Error(`row cellId length ${idBytes.length} out of range`);
    }
    if (!/^[0-9a-f]{64}$/.test(r.sourceHashHex)) {
      throw new Error(`row ${r.cellId}: sourceHashHex is not a sha256 hex digest`);
    }
    if (!Number.isFinite(r.epoch)) {
      throw new Error(`row ${r.cellId}: epoch ${String(r.epoch)} is not finite`);
    }
    const nsBytes = enc.encode(r.namespace);
    if (nsBytes.length > 0xffff) throw new Error(`row ${r.cellId}: namespace too long`);
    if (!Number.isInteger(r.flags) || r.flags < 0 || r.flags > 0xff) {
      throw new Error(`row ${r.cellId}: flags ${r.flags} out of u8 range`);
    }
    const buf = Buffer.alloc(2 + idBytes.length + 32 + 8 + 2 + nsBytes.length + 1 + dim * 4);
    let o = 0;
    buf.writeUInt16LE(idBytes.length, o);
    o += 2;
    buf.set(idBytes, o);
    o += idBytes.length;
    buf.set(Buffer.from(r.sourceHashHex, "hex"), o);
    o += 32;
    buf.writeDoubleLE(r.epoch, o);
    o += 8;
    buf.writeUInt16LE(nsBytes.length, o);
    o += 2;
    buf.set(nsBytes, o);
    o += nsBytes.length;
    buf.writeUInt8(r.flags, o);
    o += 1;
    for (let i = 0; i < dim; i++) {
      buf.writeFloatLE(r.vec[i]!, o);
      o += 4;
    }
    parts.push(buf);
  }
  return Buffer.concat(parts);
}

function decodeRows(payload: Buffer, dim: number): PersistedRow[] | string {
  if (payload.length < 4) return "payload truncated (no row count)";
  const count = payload.readUInt32LE(0);
  let o = 4;
  const rows: PersistedRow[] = [];
  const dec = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < count; i++) {
    if (o + 2 > payload.length) return `row ${i}: truncated at cellIdLen`;
    const idLen = payload.readUInt16LE(o);
    o += 2;
    if (idLen === 0) return `row ${i}: empty cellId`;
    if (o + idLen + 32 + 8 + 2 > payload.length) return `row ${i}: truncated at cellId/hash/epoch`;
    let cellId: string;
    try {
      cellId = dec.decode(payload.subarray(o, o + idLen));
    } catch {
      return `row ${i}: cellId not UTF-8`;
    }
    o += idLen;
    const sourceHashHex = payload.subarray(o, o + 32).toString("hex");
    o += 32;
    const epoch = payload.readDoubleLE(o);
    o += 8;
    const nsLen = payload.readUInt16LE(o);
    o += 2;
    if (o + nsLen + 1 + dim * 4 > payload.length) return `row ${i}: truncated at namespace/vec`;
    let namespace: string;
    try {
      namespace = dec.decode(payload.subarray(o, o + nsLen));
    } catch {
      return `row ${i}: namespace not UTF-8`;
    }
    o += nsLen;
    const flags = payload.readUInt8(o);
    o += 1;
    const vec = new Float32Array(dim);
    for (let j = 0; j < dim; j++) {
      vec[j] = payload.readFloatLE(o);
      o += 4;
    }
    rows.push({ cellId, sourceHashHex, epoch, namespace, flags, vec });
  }
  if (o !== payload.length) return `trailing ${payload.length - o} bytes after last row`;
  return rows;
}
