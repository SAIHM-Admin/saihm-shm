import { constants as bufferConstants } from "node:buffer";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { HEX64, resolveFeedPath } from "../erasure/feed_watcher.js";
import type { McpToolCaller } from "../saihm_client/mcp_client.js";
import { parseServerFeatures } from "../saihm_client/server_features.js";
import { writeFileAtomic } from "./atomic_write.js";
import { ensureStateDir } from "./state_dir.js";
import type { WarmStart } from "./warm_start.js";

export const WARM_START_DIRNAME = "warm-start";
export const CALL_TOKEN = /^[a-z0-9]{16,32}$/;
export const putFileName = (token: string): string => `put-${token}.bin`;
export const latestFileName = (token: string): string => `latest-${token}.bin`;
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_LENGTH = 24;
export function newCallToken(): string {
  let out = "";
  while (out.length < TOKEN_LENGTH) {
    for (const b of randomBytes(TOKEN_LENGTH)) {
      if (b < 252 && out.length < TOKEN_LENGTH) out += TOKEN_ALPHABET[b % 36];
    }
  }
  return out;
}

export const DEFAULT_MAX_LATEST_BYTES = 256 * 1024 * 1024;

export type LocalCode =
  | "shm_bad_argument"
  | "shm_dir_unsafe"
  | "shm_file_unsafe"
  | "shm_file_too_large"
  | "shm_file_missing"
  | "shm_answer_malformed"
  | "shm_residue"
  | "shm_io_error"
  | "shm_not_offered";

export const LOCAL_CODES: readonly LocalCode[] = Object.freeze([
  "shm_bad_argument",
  "shm_dir_unsafe",
  "shm_file_unsafe",
  "shm_file_too_large",
  "shm_file_missing",
  "shm_answer_malformed",
  "shm_residue",
  "shm_io_error",
  "shm_not_offered",
] as const);

export class McpWarmStartError extends Error {
  readonly origin: "tool" | "local";
  readonly code?: string;
  constructor(message: string, origin: "tool" | "local", code: string | undefined, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "McpWarmStartError";
    this.origin = origin;
    if (code !== undefined) this.code = code;
  }
}

const local = (code: LocalCode, message: string, cause?: unknown): McpWarmStartError => new McpWarmStartError(message, "local", code, cause);

const errno = (e: unknown): string | undefined => {
  const c = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof c === "string" ? c : undefined;
};

const SAIHM_ERROR_TEXT = /^SAIHM error \[([^\]]{0,64})\]/;
const WIRE_CODE = /^[a-z][a-z_]{0,63}$/;

export function codeFromToolText(text: string): string | undefined {
  const c = SAIHM_ERROR_TEXT.exec(text)?.[1];
  return c !== undefined && WIRE_CODE.test(c) ? c : undefined;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function codeFromErrorField(structured: unknown): string | undefined {
  if (!isPlainObject(structured)) return undefined;
  const err = structured["error"];
  if (!isPlainObject(err)) return undefined;
  const c = err["code"];
  return typeof c === "string" && WIRE_CODE.test(c) ? c : undefined;
}

export type ToolAnswer =
  | { readonly kind: "error"; readonly code: string | undefined }
  | { readonly kind: "object"; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: "null" }
  | { readonly kind: "other" }
  | { readonly kind: "malformed" };

export function readToolAnswer(raw: unknown): ToolAnswer {
  if (raw === null) return { kind: "null" };
  if (!isPlainObject(raw)) return { kind: "other" };
  const content = raw["content"];
  if (!Array.isArray(content)) return { kind: "object", value: raw };
  const isError = raw["isError"];
  if (isError !== undefined && typeof isError !== "boolean") return { kind: "malformed" };
  const first = content.filter(isPlainObject).find((c) => c["type"] === "text" && typeof c["text"] === "string")?.["text"] as string | undefined;
  if (isError === true) return { kind: "error", code: codeFromErrorField(raw["structuredContent"]) ?? (first === undefined ? undefined : codeFromToolText(first)) };
  const structured = raw["structuredContent"];
  if (structured !== undefined) return isPlainObject(structured) ? { kind: "object", value: structured } : { kind: "malformed" };
  if (first === undefined) return { kind: "other" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(first);
  } catch {
    return { kind: "other" };
  }
  if (parsed === null) return { kind: "null" };
  return isPlainObject(parsed) ? { kind: "object", value: parsed } : { kind: "other" };
}

export interface EntryStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly mode: number;
  readonly uid: number;
  readonly nlink: number;
  readonly size: number;
}

export function warmDirProblem(st: Pick<EntryStat, "isDirectory" | "isSymbolicLink" | "mode" | "uid">, uid: number): string | null {
  if (!st.isDirectory()) return st.isSymbolicLink() ? "is a symbolic link" : "is not a directory";
  if (st.uid !== uid) return "belongs to another account";
  if ((st.mode & 0o077) !== 0) return "is open to its group or to others";
  return null;
}

export function latestFileProblem(st: EntryStat, uid: number, maxBytes: number): { readonly code: "shm_file_unsafe" | "shm_file_too_large"; readonly what: string } | null {
  if (!st.isFile()) return { code: "shm_file_unsafe", what: st.isSymbolicLink() ? "is a symbolic link" : "is not a regular file" };
  if (st.nlink > 1) return { code: "shm_file_unsafe", what: "has another name (a hard link)" };
  if (st.uid !== uid) return { code: "shm_file_unsafe", what: "belongs to another account" };
  if ((st.mode & 0o077) !== 0) return { code: "shm_file_unsafe", what: "is open to its group or to others" };
  if (st.size > maxBytes) return { code: "shm_file_too_large", what: `is larger than ${maxBytes} bytes` };
  return null;
}

type Op = "put" | "latest" | "list" | "delete";
const TOOL: Readonly<Record<Op, string>> = { put: "saihm_remember", latest: "saihm_recall", list: "saihm_recall", delete: "saihm_forget" };
const named = (op: Op): string => `${TOOL[op]} (warmStart ${op})`;

const own = (o: Readonly<Record<string, unknown>>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

const ISO_MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function isIsoMsUtc(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_MS_UTC.test(v)) return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && new Date(t).toISOString() === v;
}
const isSnapshotId = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);
const isCursor = (v: unknown): v is string => typeof v === "string" && v !== "";
const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function field<T>(o: Readonly<Record<string, unknown>>, op: Op, at: string, key: string, ok: (v: unknown) => v is T, what: string): T {
  const v = own(o, key);
  if (!ok(v)) throw local("shm_answer_malformed", `${named(op)}: ${at}${key} ${what}`);
  return v;
}
const snapshotIdOf = (o: Readonly<Record<string, unknown>>, op: Op, at = "") => field(o, op, at, "snapshotId", isSnapshotId, "is not 64 lowercase hex");
const createdAtOf = (o: Readonly<Record<string, unknown>>, op: Op, at = "") => field(o, op, at, "createdAt", isIsoMsUtc, "is not an ISO-8601 UTC time with milliseconds and Z");
const bytesOf = (o: Readonly<Record<string, unknown>>, op: Op, at = "") => field(o, op, at, "bytes", isWhole, "is not a whole number");
const coversThroughOf = (o: Readonly<Record<string, unknown>>, op: Op, at = "") => field(o, op, at, "coversThrough", isCursor, "is not a non-empty cursor");

export interface McpWarmStartConfig {
  readonly callTool: McpToolCaller;
  readonly agentIdHash: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly status: unknown;
  readonly maxLatestBytes?: number;
  readonly newToken?: () => string;
}

export class McpWarmStart implements WarmStart {
  readonly dir: string;
  private readonly callTool: McpToolCaller;
  private readonly uid: number;
  private readonly maxLatestBytes: number;
  private readonly newToken: () => string;
  readonly notOffered: string | null;

  constructor(cfg: McpWarmStartConfig) {
    if (typeof cfg.callTool !== "function") throw new TypeError("McpWarmStart: callTool must be the host's MCP tool caller");
    if (typeof cfg.agentIdHash !== "string" || !HEX64.test(cfg.agentIdHash)) throw new TypeError("McpWarmStart: agentIdHash must be 64 lowercase hex");
    const tenant = dirname(resolveFeedPath({ identity: cfg.agentIdHash, env: cfg.env, homeDir: cfg.homeDir }));
    if (!isAbsolute(tenant)) {
      throw new TypeError(
        "McpWarmStart: the tenant directory resolves to a relative path. The tool runs in another process, and a relative " +
          "SAIHM_ERASURE_FEED_DIR, SAIHM_HOME or home directory names a different directory in each process's working directory.",
      );
    }
    if (typeof process.getuid !== "function") {
      throw new Error("McpWarmStart: this platform reports no POSIX owner, so the warm-start files' owner and mode cannot be judged");
    }
    const offer = parseServerFeatures(cfg.status).warmStart;
    this.notOffered = offer.kind === "available" ? null : `features.warmStart is ${offer.kind}: ${offer.reason}`;
    const offeredMax = offer.kind === "available" && offer.value.maxBytes >= 1 ? Math.min(offer.value.maxBytes, bufferConstants.MAX_LENGTH) : undefined;
    const max = cfg.maxLatestBytes ?? offeredMax ?? DEFAULT_MAX_LATEST_BYTES;
    if (!Number.isSafeInteger(max) || max < 1 || max > bufferConstants.MAX_LENGTH) {
      throw new RangeError(`McpWarmStart: maxLatestBytes must be a whole number from 1 to ${bufferConstants.MAX_LENGTH}`);
    }
    this.callTool = cfg.callTool;
    this.uid = process.getuid();
    this.maxLatestBytes = max;
    if (cfg.newToken !== undefined && typeof cfg.newToken !== "function") throw new TypeError("McpWarmStart: newToken must be a function");
    this.newToken = cfg.newToken ?? newCallToken;
    this.dir = join(tenant, WARM_START_DIRNAME);
  }

  private token(): string {
    const t = this.newToken();
    if (typeof t !== "string" || !CALL_TOKEN.test(t)) throw local("shm_bad_argument", "the call token is not 16 to 32 characters from a-z and 0-9");
    return t;
  }

  async put(payload: Uint8Array, opts: { readonly coversThrough: string }): Promise<{ readonly snapshotId: string; readonly createdAt: string; readonly bytes: number }> {
    this.offered("put");
    if (!(payload instanceof Uint8Array)) throw local("shm_bad_argument", "put: the payload must be bytes");
    const coversThrough: unknown = (opts as { readonly coversThrough?: unknown } | undefined)?.coversThrough;
    if (!isCursor(coversThrough)) throw local("shm_bad_argument", "put: coversThrough must be a non-empty cursor");
    const token = this.token();
    const putPath = join(this.dir, putFileName(token));
    await this.prepareDir();
    return this.thenRemove(
      async () => {
        await this.writePut(putPath, payload);
        const a = await this.call("put", { warmStart: "put", coversThrough, token });
        if (a.kind !== "object") throw local("shm_answer_malformed", `${named("put")}: the answer is not an object`);
        return { snapshotId: snapshotIdOf(a.value, "put"), createdAt: createdAtOf(a.value, "put"), bytes: bytesOf(a.value, "put") };
      },
      () => this.removePutFiles(putFileName(token)),
    );
  }

  async latest(): Promise<{ readonly snapshotId: string; readonly createdAt: string; readonly coversThrough: string; readonly payload: Uint8Array } | null> {
    this.offered("latest");
    const token = this.token();
    const latestPath = join(this.dir, latestFileName(token));
    await this.prepareDir();
    return this.thenRemove(
      async () => {
        const a = await this.call("latest", { warmStart: "latest", token });
        if (a.kind !== "object") throw local("shm_answer_malformed", `${named("latest")}: the answer is not an object`);
        const snap = own(a.value, "snapshot");
        if (snap === null) return null;
        if (!isPlainObject(snap)) throw local("shm_answer_malformed", `${named("latest")}: snapshot is neither null nor an object`);
        const meta = { snapshotId: snapshotIdOf(snap, "latest", "snapshot."), createdAt: createdAtOf(snap, "latest", "snapshot."), coversThrough: coversThroughOf(snap, "latest", "snapshot.") };
        return { ...meta, payload: await this.readLatest(latestPath) };
      },
      () => this.removeLatest(latestPath),
    );
  }

  async list(): Promise<ReadonlyArray<{ readonly snapshotId: string; readonly createdAt: string; readonly bytes: number; readonly coversThrough: string }>> {
    this.offered("list");
    const a = await this.call("list", { warmStart: "list", token: this.token() });
    if (a.kind !== "object") throw local("shm_answer_malformed", `${named("list")}: the answer is not an object`);
    const snapshots = own(a.value, "snapshots");
    if (!Array.isArray(snapshots)) throw local("shm_answer_malformed", `${named("list")}: snapshots is not a list`);
    const seen = new Set<string>();
    return snapshots.map((s: unknown, i) => {
      const at = `snapshots[${i}].`;
      if (!isPlainObject(s)) throw local("shm_answer_malformed", `${named("list")}: snapshots[${i}] is not an object`);
      const entry = { snapshotId: snapshotIdOf(s, "list", at), createdAt: createdAtOf(s, "list", at), bytes: bytesOf(s, "list", at), coversThrough: coversThroughOf(s, "list", at) };
      if (seen.has(entry.snapshotId)) throw local("shm_answer_malformed", `${named("list")}: ${at}snapshotId repeats`);
      seen.add(entry.snapshotId);
      return entry;
    });
  }

  async delete(snapshotId: string): Promise<void> {
    this.offered("delete");
    if (!isSnapshotId(snapshotId)) throw local("shm_bad_argument", "delete: snapshotId must be 64 lowercase hex");
    await this.call("delete", { warmStart: "delete", snapshotId, token: this.token() });
  }

  private offered(op: Op): void {
    if (this.notOffered !== null) throw local("shm_not_offered", `${named(op)}: refused — ${this.notOffered}; warm start runs only where the server offers it`);
  }

  private async call(op: Op, args: Readonly<Record<string, unknown>>): Promise<ToolAnswer> {
    let raw: unknown;
    try {
      raw = await this.callTool(TOOL[op], args);
    } catch (e) {
      const text = typeof e === "string" ? e : typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : undefined;
      const code = text === undefined ? undefined : codeFromToolText(text);
      throw new McpWarmStartError(`${named(op)}: the call threw${code === undefined ? "" : ` [${code}]`}`, "tool", code, e);
    }
    const a = readToolAnswer(raw);
    if (a.kind === "error") throw new McpWarmStartError(`${named(op)}: the tool answered with an error${a.code === undefined ? "" : ` [${a.code}]`}`, "tool", a.code);
    if (a.kind === "malformed") throw local("shm_answer_malformed", `${named(op)}: not a tool result (isError or structuredContent has the wrong type)`);
    return a;
  }

  private async thenRemove<T>(body: () => Promise<T>, remove: () => Promise<void>): Promise<T> {
    let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    try {
      outcome = { ok: true, value: await body() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    await remove();
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private async prepareDir(): Promise<void> {
    let failure: unknown;
    try {
      await ensureStateDir("McpWarmStart", this.dir);
    } catch (e) {
      failure = e;
    }
    let st;
    try {
      st = await lstat(this.dir);
    } catch (e) {
      throw local("shm_io_error", `${this.dir} could not be created or examined`, failure ?? e);
    }
    const problem = warmDirProblem(st, this.uid);
    if (problem !== null) throw local("shm_dir_unsafe", `${this.dir} ${problem}: refused, and left as it is`);
    if (failure !== undefined) throw local("shm_io_error", `${this.dir} could not be prepared`, failure);
  }

  private async writePut(putPath: string, payload: Uint8Array): Promise<void> {
    try {
      await writeFileAtomic(putPath, payload);
      const fh = await open(putPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (e) {
      throw local("shm_io_error", `${putPath} could not be written`, e);
    }
  }

  private async removePutFiles(putName: string): Promise<void> {
    const tempPrefix = putName + ".tmp.";
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if (errno(e) === "ENOENT") return;
      throw local("shm_residue", `${this.dir} could not be listed, so ${putName} may remain there in plaintext`, e);
    }
    let failed = 0;
    let first: unknown;
    for (const name of names) {
      if (name !== putName && !name.startsWith(tempPrefix)) continue;
      try {
        await unlink(join(this.dir, name));
      } catch (e) {
        if (errno(e) === "ENOENT") continue;
        failed++;
        first ??= e;
      }
    }
    if (failed > 0) throw local("shm_residue", `${failed} put file(s) in ${this.dir} could not be removed and may hold SHM's state in plaintext`, first);
  }

  private async removeLatest(latestPath: string): Promise<void> {
    try {
      await unlink(latestPath);
    } catch (e) {
      if (errno(e) !== "ENOENT") throw local("shm_residue", `${latestPath} could not be removed and may hold a snapshot in plaintext`, e);
    }
  }

  private async readLatest(latestPath: string): Promise<Uint8Array> {
    let st;
    try {
      st = await lstat(latestPath);
    } catch (e) {
      if (errno(e) === "ENOENT") throw local("shm_file_missing", `${named("latest")} named a snapshot, and ${latestPath} is not there`);
      throw local("shm_io_error", `${latestPath} could not be examined`, e);
    }
    const problem = latestFileProblem(st, this.uid, this.maxLatestBytes);
    if (problem !== null) throw local(problem.code, `${latestPath} ${problem.what}: refused`);
    let fh;
    try {
      fh = await open(latestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (e) {
      if (errno(e) === "ENOENT") throw local("shm_file_missing", `${latestPath} went away before it was read`, e);
      if (errno(e) === "ELOOP") throw local("shm_file_unsafe", `${latestPath} became a symbolic link before it was read`, e);
      throw local("shm_io_error", `${latestPath} could not be opened`, e);
    }
    try {
      const opened = await fh.stat();
      if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size) {
        throw local("shm_file_unsafe", `${latestPath} changed between the check and the read`);
      }
      const buf = Buffer.alloc(st.size);
      let at = 0;
      while (at < buf.byteLength) {
        const { bytesRead } = await fh.read(buf, at, buf.byteLength - at, at);
        if (bytesRead === 0) break;
        at += bytesRead;
      }
      if (at !== buf.byteLength || (await fh.read(Buffer.alloc(1), 0, 1, at)).bytesRead !== 0) {
        throw local("shm_file_unsafe", `${latestPath} changed size while it was read`);
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (e) {
      throw e instanceof McpWarmStartError ? e : local("shm_io_error", `${latestPath} could not be read`, e);
    } finally {
      await fh.close();
    }
  }
}
