import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, readFile, rename, stat } from "node:fs/promises";
import { writeFileAtomic } from "../store/atomic_write.js";
import { assertStateDir, ensureStateDir } from "../store/state_dir.js";
import { join } from "node:path";
import { StandingAnswerStore, type StandingAnswer } from "./standing_answers.js";

const MAGIC = Buffer.from("SHMS", "ascii");
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MAX_HEADER_LEN = 64 * 1024;
const DEFAULT_MAX_ENTRIES = 400;

interface StandingHeader {
  readonly formatVersion: 1;
  readonly tenantId: string;
  readonly count: number;
}

interface StoredEntry {
  readonly seq: number;
  readonly answer: StandingAnswer;
}

interface Payload {
  readonly version: 1;
  readonly nextSeq: number;
  readonly entries: readonly StoredEntry[];
}

export type StandingLoadResult =
  | {
      readonly state: "loaded";
      readonly count: number;
      readonly dropped: number;
    }
  | { readonly state: "absent" }
  | { readonly state: "invalid"; readonly reason: string };

export interface EncryptedStandingStoreConfig {
  readonly dir: string;
  readonly tenantId?: string;
  readonly keyBytes?: Uint8Array;
  readonly maxEntries?: number;
}

function isStandingAnswer(v: unknown): v is StandingAnswer {
  const a = v as Partial<StandingAnswer> | null;
  return (
    typeof a?.question === "string" &&
    typeof a.answer === "string" &&
    typeof a.writtenAtEpoch === "number" &&
    Number.isFinite(a.writtenAtEpoch) &&
    Array.isArray(a.evidence) &&
    a.evidence.every(
      (r: unknown) =>
        typeof (r as { cellId?: unknown })?.cellId === "string" &&
        typeof (r as { fingerprint?: unknown })?.fingerprint === "string",
    )
  );
}

export class EncryptedStandingStore {
  readonly tenantId: string;
  private readonly dir: string;
  private readonly injectedKey: Buffer | undefined;
  private readonly maxEntries: number;
  private cachedKey: Buffer | undefined;

  private entries: StoredEntry[] = [];
  private nextSeq = 1;
  private loadPromise: Promise<StandingLoadResult> | undefined;
  private quarantinePending = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(cfg: EncryptedStandingStoreConfig) {
    this.dir = cfg.dir;
    assertStateDir("EncryptedStandingStore", this.dir);
    this.tenantId = cfg.tenantId ?? "local";
    this.maxEntries =
      Number.isFinite(cfg.maxEntries) && (cfg.maxEntries as number) >= 1
        ? Math.floor(cfg.maxEntries as number)
        : DEFAULT_MAX_ENTRIES;
    if (cfg.keyBytes !== undefined) {
      if (cfg.keyBytes.length !== KEY_LEN) {
        throw new Error(`keyBytes must be ${KEY_LEN} bytes, got ${cfg.keyBytes.length}`);
      }
      this.injectedKey = Buffer.from(cfg.keyBytes);
    }
  }

  get filePath(): string {
    return join(this.dir, "standing.v1.enc");
  }

  get keyPath(): string {
    return join(this.dir, "standing.key");
  }

  get size(): number {
    return this.entries.length;
  }

  async load(): Promise<StandingLoadResult> {
    assertStateDir("EncryptedStandingStore", this.dir);
    this.loadPromise ??= this.readFileNow();
    return this.loadPromise;
  }

  private async readFileNow(): Promise<StandingLoadResult> {
    let file: Buffer;
    try {
      file = await readFile(this.filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent" };
      this.quarantinePending = true;
      return { state: "invalid", reason: `unreadable: ${String(e)}` };
    }

    const bad = (reason: string): StandingLoadResult => {
      this.quarantinePending = true;
      return { state: "invalid", reason };
    };

    if (file.length < MAGIC.length + 4) return bad("truncated (no header length)");
    if (!file.subarray(0, MAGIC.length).equals(MAGIC)) return bad("bad magic");
    const headerLen = file.readUInt32LE(MAGIC.length);
    if (headerLen === 0 || headerLen > MAX_HEADER_LEN) return bad(`header length ${headerLen} out of range`);
    const headerStart = MAGIC.length + 4;
    const ivStart = headerStart + headerLen;
    if (file.length < ivStart + IV_LEN + TAG_LEN) return bad("truncated (no iv/tag)");
    const headerBytes = file.subarray(headerStart, ivStart);

    let header: StandingHeader;
    try {
      header = JSON.parse(headerBytes.toString("utf8")) as StandingHeader;
    } catch {
      return bad("header is not JSON");
    }
    if (header?.formatVersion !== 1) return bad(`unsupported formatVersion ${String(header?.formatVersion)}`);
    if (header.tenantId !== this.tenantId) {
      return bad(`tenant mismatch: file "${header.tenantId}" != store "${this.tenantId}"`);
    }

    const iv = file.subarray(ivStart, ivStart + IV_LEN);
    const tag = file.subarray(ivStart + IV_LEN, ivStart + IV_LEN + TAG_LEN);
    const ct = file.subarray(ivStart + IV_LEN + TAG_LEN);
    let plain: Buffer;
    try {
      const key = await this.getKey();
      const d = createDecipheriv("aes-256-gcm", key, iv);
      d.setAAD(headerBytes);
      d.setAuthTag(tag);
      plain = Buffer.concat([d.update(ct), d.final()]);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("corrupt standing-store key")) throw e;
      return bad("authentication failed (tamper, wrong key, or corrupt payload)");
    }

    let payload: Payload;
    try {
      payload = JSON.parse(plain.toString("utf8")) as Payload;
    } catch {
      return bad("payload is not JSON");
    }
    if (payload?.version !== 1 || !Array.isArray(payload.entries)) return bad("payload shape");

    const kept: StoredEntry[] = [];
    for (const e of payload.entries) {
      if (typeof (e as StoredEntry)?.seq === "number" && Number.isFinite(e.seq) && isStandingAnswer(e.answer)) {
        kept.push({ seq: e.seq, answer: e.answer });
      }
    }
    this.entries = kept.slice(-this.maxEntries);
    const maxSeq = kept.reduce((m, e) => Math.max(m, e.seq), 0);
    this.nextSeq = Math.max(Number.isFinite(payload.nextSeq) ? payload.nextSeq : 0, maxSeq + 1, 1);

    return { state: "loaded", count: kept.length, dropped: payload.entries.length - kept.length };
  }

  snapshot(): StandingAnswerStore {
    const s = new StandingAnswerStore();
    for (const e of this.entries) s.remember(e.answer);
    return s;
  }

  async record(answer: StandingAnswer): Promise<number> {
    const epoch: unknown = (answer as { writtenAtEpoch?: unknown } | null)?.writtenAtEpoch;
    if (!isStandingAnswer(answer)) {
      throw new Error(
        "refusing to record a standing answer this store would drop on reload" +
          (typeof epoch === "number" && Number.isFinite(epoch) ? "" : `: writtenAtEpoch is ${String(epoch)}`),
      );
    }
    await this.load();
    const seq = this.nextSeq++;
    this.entries.push({ seq, answer });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    await this.save();
    return seq;
  }

  async conclude(handle: number, text: string): Promise<boolean> {
    await this.load();
    const i = this.entries.findIndex((e) => e.seq === handle);
    if (i < 0) return false;
    this.entries[i] = { seq: this.entries[i]!.seq, answer: { ...this.entries[i]!.answer, answer: text } };
    await this.save();
    return true;
  }

  async concludeLatest(text: string): Promise<boolean> {
    await this.load();
    const last = this.entries[this.entries.length - 1];
    return last ? this.conclude(last.seq, text) : false;
  }

  readonly purge = async (cellId: string): Promise<void> => {
    await this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !e.answer.evidence.some((r) => r.cellId === cellId));
    if (this.entries.length !== before) await this.save();
  };

  private async save(): Promise<void> {
    const payload: Payload = { version: 1, nextSeq: this.nextSeq, entries: [...this.entries] };
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const header: StandingHeader = { formatVersion: 1, tenantId: this.tenantId, count: payload.entries.length };
    const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    if (headerBytes.length > MAX_HEADER_LEN) {
      throw new Error(
        `refusing to persist standing answers: header is ${headerBytes.length} B, over the ${MAX_HEADER_LEN} B this store can read back`,
      );
    }

    const run = async (): Promise<void> => {
      const key = await this.getKey();
      if (this.quarantinePending) {
        const aside = `${this.filePath}.bad-${randomBytes(4).toString("hex")}`;
        await rename(this.filePath, aside).catch(() => {});
        this.quarantinePending = false;
      }
      const iv = randomBytes(IV_LEN);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(headerBytes);
      const ct = Buffer.concat([c.update(body), c.final()]);
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(headerBytes.length, 0);
      await this.atomicWrite(this.filePath, Buffer.concat([MAGIC, lenBuf, headerBytes, iv, c.getAuthTag(), ct]));
    };

    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }

  private async getKey(): Promise<Buffer> {
    if (this.injectedKey) return this.injectedKey;
    if (this.cachedKey) return this.cachedKey;
    assertStateDir("EncryptedStandingStore", this.dir);
    try {
      const raw = await readFile(this.keyPath);
      if (raw.length !== KEY_LEN) {
        throw new Error(
          `corrupt standing-store key ${this.keyPath} (${raw.length} bytes, want ${KEY_LEN}). ` +
            `Standing answers are NOT rebuildable: restore the key, or move ${this.filePath} aside to start over.`,
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
    await ensureStateDir("EncryptedStandingStore", this.dir);
    await writeFileAtomic(path, data);
  }
}
