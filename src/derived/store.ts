import type { SaihmPort, ShareRecipient, ShareScope } from "../saihm_client/types.js";
import type { ErasureListener } from "../erasure/bus.js";
import { verifyStandingAnswer, type EvidenceRef, type FingerprintLookup, type StandingVerdict } from "../standing/standing_answers.js";
import { encodeDerivedCell, isDerivedLabel, parseDerivedCell, type DerivedItem, type DerivedKind, type DerivedOwnership } from "./codec.js";
import type { DestructionAttestation, MintedLedger, MintedRecord } from "./ledger.js";
import { assertWriteAllowed, type ResolvedPolicy } from "../policy/store_policy.js";

export interface CommitInput {
  readonly kind: DerivedKind;
  readonly label: string;
  readonly text: string;
  readonly sources: readonly string[];
  readonly nowEpoch: number;
  readonly supersedesDerived?: readonly string[];
  readonly threads?: readonly string[];
  readonly retire?: boolean;
}

export interface CommitReceipt {
  readonly cellId: string;
  readonly item: DerivedItem;
  readonly shared?: boolean;
  readonly shareError?: string;
}

export interface CascadeReport {
  readonly erased: string;
  readonly forgotten: readonly string[];
  readonly refused: readonly { readonly cellId: string; readonly reason: string }[];
  readonly failed: readonly { readonly cellId: string; readonly error: string }[];
  readonly notAttested: readonly string[];
}

export interface AttestationRetryReport {
  readonly attested: readonly string[];
  readonly pending: readonly { readonly cellId: string; readonly reason: string }[];
  readonly notFound: readonly string[];
  readonly failed: readonly { readonly cellId: string; readonly error: string }[];
  readonly refused: readonly { readonly cellId: string; readonly reason: string }[];
}

export interface SaihmDerivedStoreOptions {
  readonly issuer: string;
  readonly fingerprintOf: FingerprintLookup;
  readonly organization?: { readonly recipient: ShareRecipient; readonly scope?: ShareScope };
  readonly onCascade?: (report: CascadeReport) => void;
  readonly policy?: () => ResolvedPolicy;
}

export class SaihmDerivedStore {
  private readonly issuer: string;
  private readonly fingerprintOf: FingerprintLookup;
  private readonly org: SaihmDerivedStoreOptions["organization"];
  private readonly onCascadeObs: ((r: CascadeReport) => void) | undefined;
  private readonly policyOf: (() => ResolvedPolicy) | undefined;
  lastCascade: CascadeReport | undefined;
  lastRetry: AttestationRetryReport | undefined;
  private retryChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly port: SaihmPort,
    private readonly ledger: MintedLedger,
    opts: SaihmDerivedStoreOptions,
  ) {
    if (!/^[0-9a-f]{64}$/.test(opts.issuer)) throw new Error("SaihmDerivedStore: issuer must be a 64-hex agentIdHash");
    this.issuer = opts.issuer;
    this.fingerprintOf = opts.fingerprintOf;
    this.org = opts.organization;
    this.onCascadeObs = opts.onCascade;
    this.policyOf = opts.policy;
  }

  async commit(input: CommitInput): Promise<CommitReceipt> {
    if (this.policyOf !== undefined) assertWriteAllowed(this.policyOf(), this.org !== undefined ? "central" : "saihm", "commit");
    const index = await this.port.readIndex();
    const live = new Map(index.filter((e) => !e.forgotten).map((e) => [e.cellId, e]));
    const sources: EvidenceRef[] = [];
    for (const cellId of input.sources) {
      const minted = await this.ledger.get(cellId);
      if (minted !== undefined && minted.forgotten !== undefined) throw new Error(`commit refused: source ${cellId.slice(0, 12)}… is a derived cell that has been erased`);
      if (!live.has(cellId)) throw new Error(`commit refused: source ${cellId.slice(0, 12)}… is not a live cell in this port's index`);
      let fp: string | undefined;
      try {
        fp = this.fingerprintOf(cellId);
      } catch {
        fp = undefined;
      }
      if (fp === undefined) throw new Error(`commit refused: source ${cellId.slice(0, 12)}… cannot be fingerprinted now — an item that cannot be verified later must not be minted`);
      sources.push({ cellId, fingerprint: fp });
    }
    const ownership: DerivedOwnership = this.org !== undefined ? "org-shared" : "agent";
    const item: DerivedItem = {
      kind: input.kind,
      issuer: this.issuer,
      sources,
      derivedAtEpoch: input.nowEpoch,
      ownership,
      ...(input.supersedesDerived !== undefined ? { supersedesDerived: input.supersedesDerived } : {}),
      ...(input.threads !== undefined ? { threads: input.threads } : {}),
      ...(input.retire === true && sources.length > 0 ? { retires: sources.map((s) => s.cellId) } : {}),
      label: input.label,
      text: input.text,
    };
    const content = encodeDerivedCell(item);
    const receipt = await this.port.remember(content);
    const rec: MintedRecord = {
      ...(input.threads !== undefined && input.threads.length > 0 ? { threads: input.threads } : {}),
      cellId: receipt.cellId, kind: item.kind, sources, derivedAtEpoch: input.nowEpoch, ownership,
      ...(item.retires !== undefined ? { retires: item.retires } : {}),
    };
    await this.ledger.add(rec);
    if (this.org === undefined) return { cellId: receipt.cellId, item };
    const shared = await this.shareToOrg(receipt.cellId);
    return { cellId: receipt.cellId, item, shared: shared.ok, ...(shared.ok ? {} : { shareError: shared.error }) };
  }

  async shareToOrg(cellId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.org === undefined) return { ok: false, error: "no organization recipient configured" };
    const rec = await this.ledger.get(cellId);
    if (rec === undefined) return { ok: false, error: "not an own-minted cell" };
    try {
      await this.port.share(cellId, this.org.recipient, this.org.scope ?? "read");
      await this.ledger.setShareError(cellId, undefined);
      return { ok: true };
    } catch (e) {
      const error = (e as Error).message;
      await this.ledger.setShareError(cellId, error);
      return { ok: false, error };
    }
  }

  async verify(cellId: string, fingerprintOf: FingerprintLookup = this.fingerprintOf): Promise<StandingVerdict | undefined> {
    const rec = await this.ledger.get(cellId);
    if (rec === undefined) return undefined;
    return verifyStandingAnswer({ question: "", answer: "", evidence: rec.sources, writtenAtEpoch: rec.derivedAtEpoch }, fingerprintOf);
  }

  async read(cellId: string): Promise<DerivedItem | undefined> {
    const entry = (await this.port.readIndex()).find((e) => e.cellId === cellId && !e.forgotten);
    if (entry === undefined) return undefined;
    const bodies = await this.port.recallByQuery(entry.label.slice(0, 80));
    const body = bodies.find((b) => b.cellId === cellId);
    return body === undefined ? undefined : parseDerivedCell(body.plaintext);
  }

  readonly onSourceErased: ErasureListener = async (erased: string): Promise<void> => {
    await this.cascade(erased);
  };

  readonly cascade = async (erased: string): Promise<CascadeReport> => {
    const forgotten: string[] = [];
    const refused: { cellId: string; reason: string }[] = [];
    const failed: { cellId: string; error: string }[] = [];
    const notAttested: string[] = [];
    const queue: string[] = [erased];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const src = queue.shift()!;
      if (visited.has(src)) continue;
      visited.add(src);
      const citing = await this.ledger.citing(src);
      if (citing.length === 0) continue;
      const index = await this.port.readIndex();
      const labelOf = new Map(index.map((e) => [e.cellId, { label: e.label, forgotten: e.forgotten }]));
      for (const rec of citing) {
        const entry = labelOf.get(rec.cellId);
        if (entry === undefined || entry.forgotten) {
          await this.ledger.markForgotten(rec.cellId, rec.derivedAtEpoch, `already absent when cascading from ${erased.slice(0, 12)}…`);
          queue.push(rec.cellId);
          continue;
        }
        if (!isDerivedLabel(entry.label)) {
          refused.push({ cellId: rec.cellId, reason: "ledger names it but its index label is not SHM-derived — not forgotten" });
          continue;
        }
        try {
          const receipt = await this.port.forget(rec.cellId);
          const unattested = receipt !== undefined && receipt.complete === false && receipt.reason === "not-attested";
          await this.ledger.markForgotten(rec.cellId, rec.derivedAtEpoch, `cascade from ${erased.slice(0, 12)}…`, unattested ? { state: "pending", tries: 1 } : undefined);
          forgotten.push(rec.cellId);
          if (unattested) notAttested.push(rec.cellId);
          queue.push(rec.cellId);
        } catch (e) {
          failed.push({ cellId: rec.cellId, error: (e as Error).message });
        }
      }
    }
    const report: CascadeReport = { erased, forgotten, refused, failed, notAttested };
    this.lastCascade = report;
    try {
      this.onCascadeObs?.(report);
    } catch {
    }
    if (failed.length > 0) {
      throw new AggregateError(
        failed.map((f) => new Error(`${f.cellId.slice(0, 12)}…: ${f.error}`)),
        `derived cascade from ${erased.slice(0, 12)}…: ${failed.length} forget(s) FAILED — erasure duty not discharged`,
      );
    }
    return report;
  };

  async retryUnattested(): Promise<AttestationRetryReport> {
    const run = this.retryChain.then(() => this.runRetry());
    this.retryChain = run.catch(() => {});
    return run;
  }

  async pendingAttestation(): Promise<readonly string[]> {
    return (await this.ledger.all()).filter(isPending).map((r) => r.cellId);
  }

  private async runRetry(): Promise<AttestationRetryReport> {
    const attested: string[] = [];
    const pending: { cellId: string; reason: string }[] = [];
    const notFound: string[] = [];
    const failed: { cellId: string; error: string }[] = [];
    const refused: { cellId: string; reason: string }[] = [];
    const records = (await this.ledger.all()).filter(isPending);
    let entryOf: Map<string, { readonly label: string; readonly forgotten: boolean }> | undefined;
    if (records.length > 0) {
      try {
        entryOf = new Map((await this.port.readIndex()).map((e) => [e.cellId, { label: e.label, forgotten: e.forgotten }]));
      } catch (e) {
        const error = `the index could not be read, so guard 2 could not be checked: ${(e as Error).message}`;
        for (const rec of records) failed.push({ cellId: rec.cellId, error });
      }
    }
    for (const rec of entryOf === undefined ? [] : records) {
      const entry = entryOf!.get(rec.cellId);
      if (entry !== undefined && !entry.forgotten && !isDerivedLabel(entry.label)) {
        refused.push({ cellId: rec.cellId, reason: "the ledger names it but its index label is not SHM-derived — not forgotten" });
        continue;
      }
      const tries = rec.attestation!.tries + 1;
      try {
        const receipt = await this.port.forget(rec.cellId);
        let next: DestructionAttestation;
        if (receipt !== undefined && receipt.complete === true) next = { state: "attested", tries };
        else if (receipt !== undefined && receipt.complete === false && receipt.reason === "not-found") next = { state: "not-found", tries };
        else next = { state: "pending", tries };
        await this.ledger.setAttestation(rec.cellId, next);
        if (next.state === "attested") attested.push(rec.cellId);
        else if (next.state === "not-found") notFound.push(rec.cellId);
        else pending.push({ cellId: rec.cellId, reason: receipt?.reason ?? "unstated" });
      } catch (e) {
        failed.push({ cellId: rec.cellId, error: (e as Error).message });
      }
    }
    const report: AttestationRetryReport = { attested, pending, notFound, failed, refused };
    this.lastRetry = report;
    return report;
  }

  readonly lineageOf = (cellId: string): readonly string[] | undefined => this.ledger.lineageOf(cellId);

  readonly retirements = (): ReadonlyMap<string, string> => this.ledger.retirements();

  async list(): Promise<readonly MintedRecord[]> {
    return (await this.ledger.all()).filter((r) => r.forgotten === undefined);
  }
}

function isPending(r: MintedRecord): boolean {
  return r.forgotten !== undefined && r.attestation?.state === "pending";
}
