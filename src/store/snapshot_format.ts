import { createHash } from "node:crypto";
import { HEX64, ISO_UTC } from "../erasure/feed_watcher.js";

export const SNAPSHOT_MAGIC = "SHMSNAP1";
export const SNAPSHOT_FORMAT_VERSION = 1 as const;
export const SNAPSHOT_MAX_HEADER_BYTES = 64 * 1024;

const PART_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface SnapshotPart {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface SnapshotManifestPart {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SnapshotManifest {
  readonly v: 1;
  readonly agentIdHash: string;
  readonly coversThrough: string;
  readonly createdAt: string;
  readonly parts: readonly SnapshotManifestPart[];
}

export interface EncodeSnapshotInput {
  readonly agentIdHash: string;
  readonly coversThrough: string;
  readonly createdAt: string;
  readonly parts: readonly SnapshotPart[];
}

export type DecodedSnapshot =
  | { readonly ok: true; readonly manifest: SnapshotManifest; readonly parts: ReadonlyMap<string, Uint8Array> }
  | { readonly ok: false; readonly reason: string };

export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFormatError";
  }
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export function partNameProblem(name: string): string | null {
  if (!PART_NAME.test(name)) return "a part name must match [a-z0-9][a-z0-9._-]{0,63}";
  return null;
}

export function encodeSnapshot(i: EncodeSnapshotInput): Uint8Array {
  if (!HEX64.test(i.agentIdHash)) throw new SnapshotFormatError("agentIdHash must be a 64-hex hash");
  if (typeof i.coversThrough !== "string" || i.coversThrough === "") throw new SnapshotFormatError("coversThrough must be a non-empty cursor");
  if (!ISO_UTC.test(i.createdAt)) throw new SnapshotFormatError("createdAt must be an ISO-8601 UTC timestamp ending in Z");
  const seen = new Set<string>();
  for (const p of i.parts) {
    const problem = partNameProblem(p.name);
    if (problem !== null) throw new SnapshotFormatError(problem);
    if (seen.has(p.name)) throw new SnapshotFormatError("part names must be unique");
    seen.add(p.name);
  }
  const manifest: SnapshotManifest = {
    v: SNAPSHOT_FORMAT_VERSION,
    agentIdHash: i.agentIdHash,
    coversThrough: i.coversThrough,
    createdAt: i.createdAt,
    parts: i.parts.map((p) => ({ name: p.name, bytes: p.bytes.byteLength, sha256: sha256(p.bytes) })),
  };
  const header = Buffer.from(JSON.stringify(manifest), "utf8");
  if (header.byteLength > SNAPSHOT_MAX_HEADER_BYTES) throw new SnapshotFormatError(`the header exceeds ${SNAPSHOT_MAX_HEADER_BYTES} bytes: too many parts`);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.byteLength, 0);
  return Buffer.concat([Buffer.from(SNAPSHOT_MAGIC, "ascii"), len, header, ...i.parts.map((p) => Buffer.from(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength))]);
}

export function decodeSnapshot(payload: Uint8Array, expect: { readonly agentIdHash: string; readonly coversThrough?: string }): DecodedSnapshot {
  const no = (reason: string): DecodedSnapshot => ({ ok: false, reason });
  const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (buf.byteLength < SNAPSHOT_MAGIC.length + 4) return no("shorter than the fixed header");
  if (buf.subarray(0, SNAPSHOT_MAGIC.length).toString("ascii") !== SNAPSHOT_MAGIC) return no("not an SHM snapshot (magic)");
  const headerLen = buf.readUInt32BE(SNAPSHOT_MAGIC.length);
  if (headerLen > SNAPSHOT_MAX_HEADER_BYTES) return no(`header length exceeds ${SNAPSHOT_MAX_HEADER_BYTES} bytes`);
  const bodyStart = SNAPSHOT_MAGIC.length + 4 + headerLen;
  if (bodyStart > buf.byteLength) return no("truncated inside the header");
  let raw: unknown;
  try {
    raw = JSON.parse(buf.subarray(SNAPSHOT_MAGIC.length + 4, bodyStart).toString("utf8"));
  } catch {
    return no("the header is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return no("the header is not a JSON object");
  const h = raw as Record<string, unknown>;
  if (h["v"] !== SNAPSHOT_FORMAT_VERSION) return no(`format version is not ${SNAPSHOT_FORMAT_VERSION}`);
  if (typeof h["agentIdHash"] !== "string" || !HEX64.test(h["agentIdHash"])) return no("agentIdHash is not a 64-hex hash");
  if (h["agentIdHash"] !== expect.agentIdHash) return no("another identity's snapshot");
  if (typeof h["coversThrough"] !== "string" || h["coversThrough"] === "") return no("coversThrough missing");
  if (expect.coversThrough !== undefined && h["coversThrough"] !== expect.coversThrough) return no("coversThrough differs from the position the snapshot was listed with");
  if (typeof h["createdAt"] !== "string" || !ISO_UTC.test(h["createdAt"])) return no("createdAt is not an ISO-8601 UTC timestamp");
  if (!Array.isArray(h["parts"])) return no("parts is not an array");
  const parts = new Map<string, Uint8Array>();
  const manifestParts: SnapshotManifestPart[] = [];
  let at = bodyStart;
  for (const p of h["parts"] as unknown[]) {
    if (typeof p !== "object" || p === null) return no("a part entry is not an object");
    const e = p as Record<string, unknown>;
    const name = e["name"], bytes = e["bytes"], digest = e["sha256"];
    if (typeof name !== "string" || partNameProblem(name) !== null) return no("a part name is not allowed");
    if (parts.has(name)) return no("a part name repeats");
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return no("a part length is not a non-negative integer");
    if (typeof digest !== "string" || !HEX64.test(digest)) return no("a part sha256 is not a 64-hex hash");
    if (at + bytes > buf.byteLength) return no("truncated inside the parts");
    const slice = buf.subarray(at, at + bytes);
    if (sha256(slice) !== digest) return no("a part's sha256 does not match its bytes");
    parts.set(name, new Uint8Array(slice));
    manifestParts.push({ name, bytes, sha256: digest });
    at += bytes;
  }
  if (at !== buf.byteLength) return no("bytes after the last part");
  return {
    ok: true,
    manifest: { v: 1, agentIdHash: h["agentIdHash"], coversThrough: h["coversThrough"], createdAt: h["createdAt"], parts: manifestParts },
    parts,
  };
}
