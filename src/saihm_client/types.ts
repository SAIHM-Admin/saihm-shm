export interface IndexEntry {
  readonly cellId: string;
  readonly label: string;
  readonly epoch: number;
  readonly byteSize: number;
  readonly tier: string;
  readonly forgotten: boolean;
  readonly forgottenEpoch?: number;
}

export interface RecalledBody {
  readonly cellId: string;
  readonly plaintext: string;
  readonly epoch: number;
  readonly tier: string;
  readonly partial?: boolean;
  readonly seq?: string;
}

export interface OwnCellRead {
  readonly cellId: string;
  readonly seq: string;
  readonly commitment: string;
  readonly plaintext: string;
}

export interface RecallOptions {
  readonly timeoutMs?: number;
}

export interface SaihmReadPort {
  readonly tenantId: string;
  readonly agentIdHash?: string | undefined;
  readIndex(): Promise<IndexEntry[]>;
  recallByQuery(query: string, opts?: RecallOptions): Promise<RecalledBody[]>;
  recallByQueryWithMeta?(query: string, opts?: RecallOptions): Promise<RecallAnswer>;
  listVersionsPage?(after?: string): Promise<ListingPage>;
  recallOwn?(cellId: string): Promise<{ readonly found: OwnCellRead | null; readonly servedBy?: string; readonly asOf?: string }>;
  readShared?(
    sharerAgentIdHash: string,
    sharerRecord: { readonly mldsaPubKey: string; readonly mlkemPubKey: string; readonly mlkemPubKeySelfSig: string },
    cellId: string,
  ): Promise<string | undefined>;
}

export interface ListingPage {
  readonly cells: readonly { readonly cellId: string; readonly seq: string | null; readonly commitment: string }[];
  readonly next: string | null;
  readonly asOf?: string;
  readonly servedBy?: string;
}

export interface RecallAnswer {
  readonly bodies: RecalledBody[];
  readonly servedBy?: string;
  readonly asOf?: string;
}

export interface RememberReceipt {
  readonly cellId: string;
  readonly shardId?: string;
  readonly seq?: string;
  readonly commitmentHash?: string;
  readonly commitment?: string;
  readonly at?: string;
}

export type ShareScope = "read" | "write" | "readwrite";

export interface ShareRecipient {
  readonly agentIdHash: string;
  readonly record?: {
    readonly mldsaPubKey: string;
    readonly mlkemPubKey: string;
    readonly mlkemPubKeySelfSig: string;
  };
}

export interface ShareOptions {
  readonly expiryEpoch?: string;
  readonly kind?: "temporary" | "permanent" | "syndicate";
}

export interface ShareReceipt {
  readonly cellId: string;
  readonly recipientAgentIdHash: string;
  readonly scope: ShareScope;
  readonly contractId?: string;
}

export interface ForgetReceipt {
  readonly complete?: boolean;
  readonly reason?: string;
  readonly destructionAnchor?: string;
  readonly at?: string;
}

export interface SaihmWritePort {
  remember(content: string): Promise<RememberReceipt>;
  forget(cellId: string): Promise<ForgetReceipt | void>;
  share(cellId: string, recipient: ShareRecipient, scope: ShareScope, opts?: ShareOptions): Promise<ShareReceipt>;
}

export type SaihmPort = SaihmReadPort & SaihmWritePort;

export class SaihmTransportError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SaihmTransportError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class IgnoredParameterError extends SaihmTransportError {
  readonly code = "ignored-parameter" as const;
  constructor(readonly parameter: string, message: string) {
    super(message);
    this.name = "IgnoredParameterError";
  }
}
