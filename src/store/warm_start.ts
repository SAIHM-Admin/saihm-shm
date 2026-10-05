import { decodeSnapshot, encodeSnapshot, SnapshotFormatError, type SnapshotPart } from "./snapshot_format.js";

export interface WarmStart {
  put(payload: Uint8Array, opts: { readonly coversThrough: string }): Promise<{ readonly snapshotId: string; readonly createdAt: string; readonly bytes: number }>;
  latest(): Promise<{ readonly snapshotId: string; readonly createdAt: string; readonly coversThrough: string; readonly payload: Uint8Array } | null>;
  list(): Promise<ReadonlyArray<{ readonly snapshotId: string; readonly createdAt: string; readonly bytes: number; readonly coversThrough: string }>>;
  delete(snapshotId: string): Promise<void>;
}

export type RestoreOutcome =
  | { readonly mode: "warm"; readonly snapshotId: string; readonly coversThrough: string; readonly parts: ReadonlyMap<string, Uint8Array> }
  | { readonly mode: "cold"; readonly reason: string };

export type TakeOutcome =
  | { readonly ok: true; readonly snapshotId: string; readonly coversThrough: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: string; readonly retryAfterApplying?: true };

const WIRE_CODE = /^[a-z][a-z_]{0,63}$/;

export function errorCode(e: unknown): string {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && WIRE_CODE.test(code) ? code : "error";
}

export async function restoreOrCold(ws: WarmStart | undefined, expect: { readonly agentIdHash: string }): Promise<RestoreOutcome> {
  if (ws === undefined) return { mode: "cold", reason: "warm start is not offered to this identity" };
  let latest: Awaited<ReturnType<WarmStart["latest"]>>;
  try {
    latest = await ws.latest();
  } catch (e) {
    return { mode: "cold", reason: `the newest snapshot could not be fetched (${errorCode(e)})` };
  }
  if (latest === null) return { mode: "cold", reason: "no snapshot" };
  const decoded = decodeSnapshot(latest.payload, { agentIdHash: expect.agentIdHash, coversThrough: latest.coversThrough });
  if (!decoded.ok) return { mode: "cold", reason: `the snapshot did not verify: ${decoded.reason}` };
  return { mode: "warm", snapshotId: latest.snapshotId, coversThrough: latest.coversThrough, parts: decoded.parts };
}

export async function takeSnapshot(
  ws: WarmStart | undefined,
  i: { readonly agentIdHash: string; readonly coversThrough: string | null; readonly createdAt: string; readonly parts: readonly SnapshotPart[] },
): Promise<TakeOutcome> {
  if (ws === undefined) return { ok: false, reason: "warm start is not offered to this identity" };
  if (i.coversThrough === null) return { ok: false, reason: "no fully applied cursor yet: a snapshot cannot claim coverage" };
  let payload: Uint8Array;
  try {
    payload = encodeSnapshot({ agentIdHash: i.agentIdHash, coversThrough: i.coversThrough, createdAt: i.createdAt, parts: i.parts });
  } catch (e) {
    return { ok: false, reason: e instanceof SnapshotFormatError ? e.message : "the payload could not be built" };
  }
  try {
    const r = await ws.put(payload, { coversThrough: i.coversThrough });
    return { ok: true, snapshotId: r.snapshotId, coversThrough: i.coversThrough, bytes: r.bytes };
  } catch (e) {
    const code = errorCode(e);
    if (code === "snapshot_superseded") {
      return { ok: false, retryAfterApplying: true, reason: "an erasure reached this identity after the covered position: apply the pending lines, then take a new snapshot" };
    }
    return { ok: false, reason: `the snapshot was not confirmed as stored (${code})` };
  }
}

export async function deleteAllBut(ws: WarmStart, keep: string): Promise<{ readonly deleted: number; readonly failed: readonly string[] }> {
  const listed = await ws.list();
  let deleted = 0;
  const failed: string[] = [];
  for (const s of listed) {
    if (s.snapshotId === keep) continue;
    try {
      await ws.delete(s.snapshotId);
      deleted++;
    } catch (e) {
      if (errorCode(e) === "snapshot_not_found") deleted++;
      else failed.push(errorCode(e));
    }
  }
  return { deleted, failed };
}
