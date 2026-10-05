import type { MemoryRecord } from "../ingest/types.js";

export const FLAG_SALIENCE_FLOOR = 1 << 0;
export const FLAG_DECAY_EXEMPT = 1 << 1;
export const FLAG_QUARANTINED = 1 << 2;
export const FLAG_SUPERSEDED_HINT = 1 << 3;

export function recordFlags(r: MemoryRecord): number {
  return (
    (r.salienceFloor ? FLAG_SALIENCE_FLOOR : 0) |
    (r.decayExempt ? FLAG_DECAY_EXEMPT : 0) |
    (r.quarantined ? FLAG_QUARANTINED : 0) |
    (r.supersededHint ? FLAG_SUPERSEDED_HINT : 0)
  );
}

export interface PersistedRow {
  readonly cellId: string;
  readonly sourceHashHex: string;
  readonly epoch: number;
  readonly namespace: string;
  readonly flags: number;
  readonly vec: Float32Array;
}

export interface StoreHeader {
  readonly formatVersion: 1;
  readonly modelId: string;
  readonly dim: number;
  readonly count: number;
  readonly tenantId: string;
  readonly builtEpoch: number;
}

export interface ExpectedSpace {
  readonly modelId: string;
  readonly dim: number;
}

export type LoadResult =
  | { readonly state: "loaded"; readonly header: StoreHeader; readonly rows: readonly PersistedRow[] }
  | { readonly state: "absent" }
  | { readonly state: "invalid"; readonly reason: string };
