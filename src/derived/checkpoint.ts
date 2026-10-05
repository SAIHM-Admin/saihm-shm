import type { ResumeClaim } from "../resume/resume.js";
import type { SaihmDerivedStore, CommitReceipt } from "./store.js";
import type { MintedLedger, MintedRecord } from "./ledger.js";

export const CHECKPOINT_MARKER = "SHM-CHECKPOINT:v1";

export interface CheckpointState {
  readonly claims: readonly ResumeClaim[];
  readonly note?: string;
}

export function encodeCheckpointText(state: CheckpointState): string {
  if (!Array.isArray(state.claims)) throw new Error("checkpoint: claims must be an array");
  const claims = state.claims.map((c, i) => {
    if (typeof c !== "object" || c === null) throw new Error(`checkpoint: claim ${i} is not an object`);
    if (typeof c.id !== "string" || c.id.trim() === "") throw new Error(`checkpoint: claim ${i} has no id`);
    if (typeof c.stated !== "string") throw new Error(`checkpoint: claim ${c.id} has no stated value`);
    return c;
  });
  const ids = new Set<string>();
  for (const c of claims) {
    if (ids.has(c.id)) throw new Error(`checkpoint: duplicate claim id ${JSON.stringify(c.id)}`);
    ids.add(c.id);
  }
  if (state.note !== undefined && typeof state.note !== "string") throw new Error("checkpoint: note must be a string");
  const body = { claims, ...(state.note !== undefined ? { note: state.note } : {}) };
  return `${CHECKPOINT_MARKER}\n${JSON.stringify(body)}`;
}

export function parseCheckpointText(text: string): CheckpointState | undefined {
  if (typeof text !== "string") return undefined;
  const nl = text.indexOf("\n");
  if (nl === -1 || text.slice(0, nl).trim() !== CHECKPOINT_MARKER) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text.slice(nl + 1));
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o["claims"])) return undefined;
  const claims: ResumeClaim[] = [];
  const ids = new Set<string>();
  for (const c of o["claims"]) {
    if (typeof c !== "object" || c === null) return undefined;
    const r = c as Record<string, unknown>;
    if (typeof r["id"] !== "string" || r["id"].trim() === "" || typeof r["stated"] !== "string") return undefined;
    if (ids.has(r["id"])) return undefined;
    ids.add(r["id"]);
    claims.push(r as unknown as ResumeClaim);
  }
  if (o["note"] !== undefined && typeof o["note"] !== "string") return undefined;
  return { claims, ...(typeof o["note"] === "string" ? { note: o["note"] } : {}) };
}

export interface WriteCheckpointInput {
  readonly thread: string;
  readonly sources: readonly string[];
  readonly state: CheckpointState;
  readonly nowEpoch: number;
  readonly label?: string;
  readonly supersedes?: string;
}

export function writeCheckpoint(store: SaihmDerivedStore, input: WriteCheckpointInput): Promise<CommitReceipt> {
  const thread = input.thread.trim();
  if (thread === "") throw new Error("checkpoint: thread slug is required");
  return store.commit({
    kind: "checkpoint",
    label: input.label ?? `checkpoint ${thread}`,
    text: encodeCheckpointText(input.state),
    sources: input.sources,
    nowEpoch: input.nowEpoch,
    threads: [thread],
    ...(input.supersedes !== undefined ? { supersedesDerived: [input.supersedes] } : {}),
  });
}

export async function latestCheckpoint(ledger: MintedLedger, thread: string): Promise<MintedRecord | undefined> {
  let best: MintedRecord | undefined;
  for (const r of await ledger.all()) {
    if (r.kind !== "checkpoint" || r.forgotten !== undefined) continue;
    if (r.threads === undefined || !r.threads.includes(thread)) continue;
    if (best === undefined || r.derivedAtEpoch >= best.derivedAtEpoch) best = r;
  }
  return best;
}

export async function readCheckpoint(store: SaihmDerivedStore, cellId: string): Promise<CheckpointState | undefined> {
  const item = await store.read(cellId);
  if (item === undefined || item.kind !== "checkpoint") return undefined;
  return parseCheckpointText(item.text);
}
