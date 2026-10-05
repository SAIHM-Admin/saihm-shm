import { createHash } from "node:crypto";
import type {
  ForgetReceipt, IndexEntry, RecalledBody, RecallOptions, RememberReceipt, SaihmPort, ShareOptions, ShareReceipt,
  ShareRecipient, ShareScope,
} from "./types.js";
import { SaihmTransportError } from "./types.js";
import { guardContent, guardShare } from "./share_guard.js";

interface Cell { readonly cellId: string; readonly shardId: string; readonly epoch: number; body: string | undefined; forgotten: boolean }

export interface InMemorySaihmPortOptions {
  readonly tenantId?: string;
  readonly agentIdHash?: string;
  readonly startEpoch?: number;
  readonly recallCap?: number;
  readonly maxContentChars?: number;
  readonly cellIdHexLength?: 32 | 64;
}

export class InMemorySaihmPort implements SaihmPort {
  readonly tenantId: string;
  readonly agentIdHash: string | undefined;
  private readonly cells = new Map<string, Cell>();
  private readonly order: string[] = [];
  private nextEpoch: number;
  private readonly recallCap: number;
  private readonly maxContentChars: number;
  private readonly cellIdHexLength: 32 | 64;
  readonly shares: ShareReceipt[] = [];

  constructor(opts: InMemorySaihmPortOptions = {}) {
    this.tenantId = opts.tenantId ?? "local";
    this.agentIdHash = opts.agentIdHash;
    this.nextEpoch = Number.isFinite(opts.startEpoch) ? (opts.startEpoch as number) : 0;
    this.recallCap = Number.isFinite(opts.recallCap) && (opts.recallCap as number) >= 1 ? Math.floor(opts.recallCap as number) : 200;
    this.maxContentChars = Number.isFinite(opts.maxContentChars) && (opts.maxContentChars as number) >= 1 ? Math.floor(opts.maxContentChars as number) : 100_000;
    this.cellIdHexLength = opts.cellIdHexLength === 32 ? 32 : 64;
  }

  async readIndex(): Promise<IndexEntry[]> {
    return this.order.map((id) => {
      const c = this.cells.get(id)!;
      return {
        cellId: c.cellId,
        label: (c.body ?? "").slice(0, 120),
        epoch: c.epoch,
        byteSize: c.body === undefined ? 0 : Buffer.byteLength(c.body, "utf8"),
        tier: "memory",
        forgotten: c.forgotten,
      };
    });
  }

  async recallByQuery(query: string, _opts?: RecallOptions): Promise<RecalledBody[]> {
    const q = query.trim().toLowerCase();
    if (q.length === 0) throw new SaihmTransportError("empty query rejected (would trigger a bulk recall)");
    const out: RecalledBody[] = [];
    for (const id of this.order) {
      const c = this.cells.get(id)!;
      if (c.forgotten || c.body === undefined) continue;
      if (!c.body.toLowerCase().includes(q)) continue;
      out.push({ cellId: c.cellId, plaintext: c.body, epoch: c.epoch, tier: "memory" });
      if (out.length >= this.recallCap) break;
    }
    return out;
  }

  async remember(content: string): Promise<RememberReceipt> {
    const text = guardContent(content, this.maxContentChars);
    const cellId = createHash("sha256").update(`${this.order.length}:${text}`).digest("hex").slice(0, this.cellIdHexLength);
    const shardId = createHash("sha256").update(`shard:${cellId}`).digest("hex");
    this.cells.set(cellId, { cellId, shardId, epoch: this.nextEpoch, body: text, forgotten: false });
    if (this.nextEpoch !== 0) this.nextEpoch += 1;
    this.order.push(cellId);
    return { cellId, shardId, seq: "1" };
  }

  async forget(cellId: string): Promise<ForgetReceipt | void> {
    const c = this.cells.get(cellId);
    if (c === undefined) throw new SaihmTransportError(`forget refused: unknown cellId ${cellId.slice(0, 12)}…`);
    if (c.forgotten) throw new SaihmTransportError(`forget refused: ${cellId.slice(0, 12)}… is already forgotten`);
    c.forgotten = true;
    c.body = undefined;
  }

  async share(cellId: string, recipient: ShareRecipient, scope: ShareScope, opts: ShareOptions = {}): Promise<ShareReceipt> {
    const id = guardShare(recipient, scope, opts);
    const c = this.cells.get(cellId);
    if (c === undefined || c.forgotten) throw new SaihmTransportError(`share refused: ${cellId.slice(0, 12)}… is not a live cell`);
    const receipt: ShareReceipt = {
      cellId,
      recipientAgentIdHash: id,
      scope,
      contractId: createHash("sha256").update(`${id}:${c.shardId}:${scope}:${opts.expiryEpoch ?? ""}`).digest("hex"),
    };
    this.shares.push(receipt);
    return receipt;
  }

  bodyOf(cellId: string): string | undefined {
    return this.cells.get(cellId)?.body;
  }

  private readonly inbound = new Map<string, Map<string, string>>();

  receiveShare(sharerAgentIdHash: string, cellId: string, plaintext: string): void {
    const id = sharerAgentIdHash.toLowerCase();
    const m = this.inbound.get(id) ?? new Map<string, string>();
    m.set(cellId, plaintext);
    this.inbound.set(id, m);
  }

  async readShared(sharerAgentIdHash: string, sharerRecord: { readonly mldsaPubKey: string; readonly mlkemPubKey: string; readonly mlkemPubKeySelfSig: string }, cellId: string): Promise<string | undefined> {
    const id = guardShare({ agentIdHash: sharerAgentIdHash, record: sharerRecord }, "read");
    return this.inbound.get(id)?.get(cellId);
  }
}
