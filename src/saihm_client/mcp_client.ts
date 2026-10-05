import type {
  ForgetReceipt, IndexEntry, ListingPage, OwnCellRead, RecallAnswer, RecalledBody, RecallOptions, RememberReceipt, SaihmPort, ShareOptions, ShareReceipt,
  ShareRecipient, ShareScope,
} from "./types.js";
import { IgnoredParameterError, SaihmTransportError } from "./types.js";
import { guardContent, guardShare } from "./share_guard.js";

export type McpToolCaller = (toolName: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>;

export interface McpClientConfig {
  readonly endpoint: string;
  readonly tenantId: string;
  readonly authToken?: string;
  readonly callTool?: McpToolCaller;
  readonly maxContentChars?: number;
}

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^\d+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const LABEL = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;

function servedByOf(r: Record<string, unknown>): { servedBy?: string } {
  if (!Object.prototype.hasOwnProperty.call(r, "servedBy") || r["servedBy"] === undefined) return {};
  const v = r["servedBy"];
  return { servedBy: typeof v === "string" && LABEL.test(v) ? v : "(unreadable)" };
}

const asOfOf = (r: Record<string, unknown>): { asOf?: string } => (typeof r["asOf"] === "string" && ISO_UTC.test(r["asOf"]) ? { asOf: r["asOf"] } : {});

export type { OwnCellRead } from "./types.js";

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const excerpt = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").trim().slice(0, 200);

export function unwrapToolResult(raw: unknown, opts: { readonly requireObject?: boolean } = {}): unknown {
  if (!isPlainObject(raw) || !Array.isArray(raw["content"])) return raw;
  const texts = (raw["content"] as unknown[]).filter(isPlainObject).filter((c) => c["type"] === "text" && typeof c["text"] === "string").map((c) => c["text"] as string);
  if (raw["isError"] === true) throw new SaihmTransportError(`the tool reported an error: ${excerpt(texts[0] ?? "(no text)")}`);
  if (isPlainObject(raw["structuredContent"])) return raw["structuredContent"];
  const first = texts[0];
  if (first !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(first);
    } catch {
      parsed = undefined;
    }
    if (isPlainObject(parsed)) return parsed;
  }
  if (opts.requireObject === false) return {};
  throw new SaihmTransportError("the tool answered with display text and no structured result — fail-closed");
}

export class McpSaihmClient implements SaihmPort {
  readonly tenantId: string;
  private readonly cfg: McpClientConfig;

  constructor(cfg: McpClientConfig) {
    this.cfg = cfg;
    this.tenantId = cfg.tenantId;
  }

  private caller(what: string, requireObject = true): McpToolCaller {
    const callTool = this.cfg.callTool;
    if (callTool === undefined) {
      throw new SaihmTransportError(`McpSaihmClient.${what}: no callTool supplied (endpoint=${this.cfg.endpoint})`);
    }
    return async (toolName, args) => unwrapToolResult(await callTool(toolName, args), { requireObject });
  }

  async status(): Promise<Readonly<Record<string, unknown>>> {
    const call = this.caller("status");
    let raw: unknown;
    try {
      raw = await call("saihm_status", {});
    } catch (e) {
      throw new SaihmTransportError("status: saihm_status failed", e);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new SaihmTransportError("status: saihm_status returned no status object — fail-closed");
    }
    return raw as Readonly<Record<string, unknown>>;
  }

  readIndex(): Promise<IndexEntry[]> {
    return Promise.reject(
      new SaihmTransportError(
        `McpSaihmClient.readIndex: the public MCP surface exposes no label index — supply one through another port (endpoint=${this.cfg.endpoint})`,
      ),
    );
  }

  async recallByQuery(query: string, opts?: RecallOptions): Promise<RecalledBody[]> {
    return (await this.recallByQueryWithMeta(query, opts)).bodies;
  }

  async recallByQueryWithMeta(query: string, _opts?: RecallOptions): Promise<RecallAnswer> {
    const q = query.trim();
    if (q.length === 0) throw new SaihmTransportError("empty query rejected (would recall every cell)");
    const call = this.caller("recallByQuery");
    let raw: unknown;
    try {
      raw = await call("saihm_recall", { query: q });
    } catch (e) {
      throw new SaihmTransportError(`recallByQuery: saihm_recall failed for ${JSON.stringify(q)}`, e);
    }
    const rec = asRecord(raw);
    const mem = rec["memories"];
    if (!Array.isArray(mem)) throw new SaihmTransportError("recallByQuery: saihm_recall result carries no `memories` array — fail-closed");
    const out: RecalledBody[] = [];
    for (const m of mem) {
      const r = asRecord(m);
      if (typeof r["cellId"] !== "string" || typeof r["plaintext"] !== "string") continue;
      const seq = r["seq"];
      out.push({ cellId: r["cellId"], plaintext: r["plaintext"], epoch: 0, tier: "saihm", ...(typeof seq === "string" && DECIMAL.test(seq) ? { seq } : {}) });
    }
    return { bodies: out, ...servedByOf(rec), ...asOfOf(rec) };
  }

  async recallOwn(cellId: string): Promise<{ readonly found: OwnCellRead | null; readonly servedBy?: string; readonly asOf?: string }> {
    if (typeof cellId !== "string" || cellId === "") throw new SaihmTransportError("recallOwn refused: empty cellId");
    const call = this.caller("recallOwn");
    let raw: unknown;
    try {
      raw = await call("saihm_recall", { cellId });
    } catch (e) {
      throw new SaihmTransportError(`recallOwn: saihm_recall failed for ${excerpt(cellId.slice(0, 12))}…`, e);
    }
    const rec = asRecord(raw);
    const meta = { ...servedByOf(rec), ...asOfOf(rec) };
    const said = rec["found"];
    if (said !== undefined && typeof said !== "boolean") throw new SaihmTransportError("recallOwn: found is neither true nor false — fail-closed");
    const mem = rec["memories"];
    if (said === false) {
      if (mem !== undefined && !(Array.isArray(mem) && mem.length === 0)) throw new SaihmTransportError("recallOwn: found false beside memories — contradictory, fail-closed");
      return { found: null, ...meta };
    }
    if (!Array.isArray(mem)) throw new SaihmTransportError("recallOwn: saihm_recall result carries no `memories` array — fail-closed");
    const rows = mem.map(asRecord);
    if (rows.some((m) => m["cellId"] !== cellId)) {
      throw new IgnoredParameterError("cellId", "recallOwn: the answer holds cells other than the one asked for, so it is refused (cellId was not applied)");
    }
    const hit = rows.find((m) => m["cellId"] === cellId);
    if (hit === undefined) {
      if (said === true) throw new SaihmTransportError("recallOwn: found true without the cell — contradictory, fail-closed");
      return { found: null, ...meta };
    }
    const seq = hit["seq"], commitment = hit["commitment"], plaintext = hit["plaintext"];
    if (typeof seq !== "string" || !DECIMAL.test(seq)) throw new SaihmTransportError("recallOwn: the cell carries no decimal seq — fail-closed");
    if (typeof commitment !== "string" || !HEX64.test(commitment)) throw new SaihmTransportError("recallOwn: the cell carries no 64-hex commitment — fail-closed");
    if (typeof plaintext !== "string") throw new SaihmTransportError("recallOwn: the cell carries no plaintext — fail-closed");
    return { found: { cellId, seq, commitment, plaintext }, ...meta };
  }

  async listVersionsPage(after?: string): Promise<ListingPage> {
    if (after !== undefined && (typeof after !== "string" || after === "")) throw new SaihmTransportError("listVersionsPage refused: an empty `after`");
    const call = this.caller("listVersionsPage");
    let raw: unknown;
    try {
      raw = await call("saihm_recall", { listOnly: true, ...(after !== undefined ? { after } : {}) });
    } catch (e) {
      throw new SaihmTransportError("listVersionsPage: saihm_recall failed", e);
    }
    const rec = asRecord(raw);
    if (Object.prototype.hasOwnProperty.call(rec, "mode") && rec["mode"] !== "list") {
      throw new SaihmTransportError("listVersionsPage: the answer states a mode other than \"list\" — not a listing, fail-closed");
    }
    const mem = rec["memories"];
    if (mem !== undefined && !(Array.isArray(mem) && mem.length === 0)) {
      throw new SaihmTransportError("listVersionsPage: the answer carries memories — a recall, not a listing (a listing carries no content); fail-closed");
    }
    const cells = rec["cells"];
    if (!Array.isArray(cells)) throw new SaihmTransportError("listVersionsPage: the answer is not a listing (no `cells` array) — fail-closed");
    const next = rec["next"];
    if (next !== null && (typeof next !== "string" || next === "")) throw new SaihmTransportError("listVersionsPage: `next` is not stated as null or an id — not a listing, fail-closed");
    const out: { cellId: string; seq: string | null; commitment: string }[] = [];
    for (const c of cells) {
      const r = asRecord(c);
      const id = r["cellId"], seq = r["seq"], commitment = r["commitment"];
      if (typeof id !== "string" || id === "") throw new SaihmTransportError("listVersionsPage: a listed cell has no cellId — fail-closed");
      if (seq !== null && (typeof seq !== "string" || !DECIMAL.test(seq))) throw new SaihmTransportError("listVersionsPage: a listed cell's seq is neither null nor decimal — fail-closed");
      if (typeof commitment !== "string" || !HEX64.test(commitment)) throw new SaihmTransportError("listVersionsPage: a listed cell has no 64-hex commitment — fail-closed");
      out.push({ cellId: id, seq, commitment });
    }
    return { cells: out, next: next as string | null, ...asOfOf(rec), ...servedByOf(rec) };
  }

  async readShared(
    sharerAgentIdHash: string,
    sharerRecord: { readonly mldsaPubKey: string; readonly mlkemPubKey: string; readonly mlkemPubKeySelfSig: string },
    cellId: string,
  ): Promise<string | undefined> {
    const call = this.caller("readShared");
    let raw: unknown;
    try {
      raw = await call("saihm_recall", { sharerPinnedAgentIdHashHex: sharerAgentIdHash, sharerRecord, cellId });
    } catch (e) {
      throw new SaihmTransportError(`readShared: saihm_recall failed for ${cellId.slice(0, 12)}… from ${sharerAgentIdHash.slice(0, 8)}…`, e);
    }
    const mem = asRecord(raw)["memories"];
    if (!Array.isArray(mem)) return undefined;
    const hit = mem.map(asRecord).find((m) => m["cellId"] === cellId && typeof m["plaintext"] === "string");
    return hit === undefined ? undefined : (hit["plaintext"] as string);
  }

  async remember(content: string): Promise<RememberReceipt> {
    const text = guardContent(content, this.cfg.maxContentChars ?? 100_000);
    const call = this.caller("remember");
    let raw: unknown;
    try {
      raw = await call("saihm_remember", { content: text });
    } catch (e) {
      throw new SaihmTransportError("remember: saihm_remember failed", e);
    }
    const r = asRecord(raw);
    if (typeof r["cellId"] !== "string" || r["cellId"] === "") {
      throw new SaihmTransportError("remember: saihm_remember returned no cellId — refusing to report a mint that cannot be referenced");
    }
    const commitment = typeof r["commitment"] === "string" && HEX64.test(r["commitment"]) ? r["commitment"]
      : typeof r["commitmentHash"] === "string" && HEX64.test(r["commitmentHash"]) ? r["commitmentHash"] : undefined;
    return {
      cellId: r["cellId"],
      ...(typeof r["shardId"] === "string" ? { shardId: r["shardId"] } : {}),
      ...(typeof r["seq"] === "string" ? { seq: r["seq"] } : {}),
      ...(typeof r["commitmentHash"] === "string" ? { commitmentHash: r["commitmentHash"] } : {}),
      ...(commitment !== undefined ? { commitment } : {}),
      ...(typeof r["at"] === "string" && ISO_UTC.test(r["at"]) ? { at: r["at"] } : {}),
    };
  }

  async forget(cellId: string): Promise<ForgetReceipt> {
    if (typeof cellId !== "string" || cellId.trim() === "") throw new SaihmTransportError("forget refused: empty cellId");
    const call = this.caller("forget", false);
    let raw: unknown;
    try {
      raw = await call("saihm_forget", { id: cellId });
    } catch (e) {
      throw new SaihmTransportError(`forget: saihm_forget failed for ${cellId.slice(0, 12)}…`, e);
    }
    const r = asRecord(raw);
    const complete = r["complete"], reason = r["reason"], anchor = r["destructionAnchor"], at = r["at"];
    return {
      ...(typeof complete === "boolean" ? { complete } : {}),
      ...(typeof reason === "string" && /^[a-z][a-z-]{0,63}$/.test(reason) ? { reason } : {}),
      ...(typeof anchor === "string" && anchor !== "" ? { destructionAnchor: anchor } : {}),
      ...(typeof at === "string" && ISO_UTC.test(at) ? { at } : {}),
    };
  }

  async share(cellId: string, recipient: ShareRecipient, scope: ShareScope, opts: ShareOptions = {}): Promise<ShareReceipt> {
    const id = guardShare(recipient, scope, opts);
    if (recipient.record === undefined) {
      throw new SaihmTransportError("share refused: the MCP share needs the recipient's published record (the cell key is re-wrapped to their ML-KEM key)");
    }
    const call = this.caller("share", false);
    let raw: unknown;
    try {
      raw = await call("saihm_share", {
        cellId,
        recipientPinnedAgentIdHashHex: id,
        recipientRecord: recipient.record,
        scope,
        ...(opts.expiryEpoch !== undefined ? { expiryEpoch: opts.expiryEpoch } : {}),
      });
    } catch (e) {
      throw new SaihmTransportError(`share: saihm_share failed for ${cellId.slice(0, 12)}… → ${id.slice(0, 8)}…`, e);
    }
    const r = asRecord(raw);
    return { cellId, recipientAgentIdHash: id, scope, ...(typeof r["contractId"] === "string" ? { contractId: r["contractId"] } : {}) };
  }
}
