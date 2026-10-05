import type { ExpectedSpace, PersistedRow } from "./types.js";

export const INDEX_PART_NAME = "index.rows";

const MAGIC = Buffer.from("SHMIDX1\n", "ascii");
const MAX_HEADER_BYTES = 4096;
const HASH_BYTES = 32;
const HEX64 = /^[0-9a-f]{64}$/;

export class IndexPartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexPartError";
  }
}

export function encodeIndexPart(rows: readonly PersistedRow[], space: ExpectedSpace): Uint8Array {
  if (typeof space.modelId !== "string" || space.modelId === "") throw new IndexPartError("the space has no model id");
  if (!Number.isSafeInteger(space.dim) || space.dim < 1 || space.dim > 65_536) throw new IndexPartError("the space's dimension is not a whole number from 1 to 65536");
  const header = Buffer.from(JSON.stringify({ v: 1, modelId: space.modelId, dim: space.dim, count: rows.length }), "utf8");
  if (header.length > MAX_HEADER_BYTES) throw new IndexPartError(`the header is longer than ${MAX_HEADER_BYTES} bytes`);
  const chunks: Buffer[] = [MAGIC, u32(header.length), header];
  for (const [i, r] of rows.entries()) {
    const id = Buffer.from(r.cellId, "utf8");
    const ns = Buffer.from(r.namespace, "utf8");
    if (id.length === 0 || id.length > 0xffff) throw new IndexPartError(`row ${i}: the cell id is empty or longer than 65535 bytes`);
    if (ns.length > 0xffff) throw new IndexPartError(`row ${i}: the namespace is longer than 65535 bytes`);
    if (!HEX64.test(r.sourceHashHex)) throw new IndexPartError(`row ${i}: the source hash is not 64 lowercase hex`);
    if (!Number.isFinite(r.epoch)) throw new IndexPartError(`row ${i}: the epoch is not a finite number`);
    if (!Number.isInteger(r.flags) || r.flags < 0 || r.flags > 0xff) throw new IndexPartError(`row ${i}: the flags are not one byte`);
    if (r.vec.length !== space.dim) throw new IndexPartError(`row ${i}: the vector has ${r.vec.length} components, the space ${space.dim}`);
    const head = Buffer.alloc(2);
    head.writeUInt16LE(id.length);
    const mid = Buffer.alloc(HASH_BYTES + 8 + 2);
    Buffer.from(r.sourceHashHex, "hex").copy(mid, 0);
    mid.writeDoubleLE(r.epoch, HASH_BYTES);
    mid.writeUInt16LE(ns.length, HASH_BYTES + 8);
    const vec = Buffer.alloc(4 * space.dim);
    for (let j = 0; j < space.dim; j++) {
      const x = r.vec[j]!;
      if (!Number.isFinite(x)) throw new IndexPartError(`row ${i}: the vector has a component that is not finite`);
      vec.writeFloatLE(x, 4 * j);
    }
    chunks.push(head, id, mid, ns, Buffer.from([r.flags]), vec);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export type DecodedIndexPart = { readonly ok: true; readonly rows: readonly PersistedRow[] } | { readonly ok: false; readonly reason: string };

export function decodeIndexPart(bytes: Uint8Array, expect: ExpectedSpace): DecodedIndexPart {
  const no = (reason: string): DecodedIndexPart => ({ ok: false, reason });
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < MAGIC.length + 4 || !b.subarray(0, MAGIC.length).equals(MAGIC)) return no("not an index part (magic)");
  const headerLen = b.readUInt32LE(MAGIC.length);
  if (headerLen > MAX_HEADER_BYTES) return no("the header is too long");
  let at = MAGIC.length + 4;
  if (at + headerLen > b.length) return no("the header runs past the end");
  let header: unknown;
  try {
    header = JSON.parse(b.subarray(at, at + headerLen).toString("utf8"));
  } catch {
    return no("the header is not JSON");
  }
  at += headerLen;
  if (typeof header !== "object" || header === null || Array.isArray(header)) return no("the header is not an object");
  const h = header as Record<string, unknown>;
  if (h["v"] !== 1) return no("the header's version is not 1");
  const modelId = h["modelId"], dim = h["dim"], count = h["count"];
  if (typeof modelId !== "string" || !Number.isSafeInteger(dim) || !Number.isSafeInteger(count) || (count as number) < 0) return no("the header's fields are malformed");
  if (modelId !== expect.modelId || dim !== expect.dim) return no(`made with another embedding space (${modelId}, ${String(dim)}) than this session's (${expect.modelId}, ${expect.dim})`);
  const d = dim as number;
  const rows: PersistedRow[] = [];
  for (let i = 0; i < (count as number); i++) {
    if (at + 2 > b.length) return no(`row ${i} runs past the end`);
    const idLen = b.readUInt16LE(at);
    at += 2;
    if (idLen === 0 || at + idLen + HASH_BYTES + 8 + 2 > b.length) return no(`row ${i} runs past the end`);
    const cellId = b.subarray(at, at + idLen).toString("utf8");
    at += idLen;
    const sourceHashHex = b.subarray(at, at + HASH_BYTES).toString("hex");
    at += HASH_BYTES;
    const epoch = b.readDoubleLE(at);
    at += 8;
    const nsLen = b.readUInt16LE(at);
    at += 2;
    if (at + nsLen + 1 + 4 * d > b.length) return no(`row ${i} runs past the end`);
    const namespace = b.subarray(at, at + nsLen).toString("utf8");
    at += nsLen;
    const flags = b.readUInt8(at);
    at += 1;
    const vec = new Float32Array(d);
    for (let j = 0; j < d; j++) {
      const x = b.readFloatLE(at + 4 * j);
      if (!Number.isFinite(x)) return no(`row ${i}: a vector component is not finite`);
      vec[j] = x;
    }
    at += 4 * d;
    if (!Number.isFinite(epoch)) return no(`row ${i}: the epoch is not finite`);
    rows.push({ cellId, sourceHashHex, epoch, namespace, flags, vec });
  }
  if (at !== b.length) return no("bytes follow the last row");
  return { ok: true, rows };
}

function u32(n: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(n);
  return out;
}
