import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../store/atomic_write.js";
import { assertStateDir, ensureStateDir } from "../store/state_dir.js";
import { dirname } from "node:path";
import type { EvidenceRef } from "../standing/standing_answers.js";
import type { DerivedKind, DerivedOwnership } from "./codec.js";

export interface MintedRecord {
  readonly cellId: string;
  readonly kind: DerivedKind;
  readonly sources: readonly EvidenceRef[];
  readonly derivedAtEpoch: number;
  readonly ownership: DerivedOwnership;
  readonly forgotten?: { readonly atEpoch: number; readonly because: string };
  readonly shareError?: string;
  readonly retires?: readonly string[];
  readonly threads?: readonly string[];
  readonly attestation?: DestructionAttestation;
}

export interface DestructionAttestation {
  readonly state: "pending" | "attested" | "not-found";
  readonly tries: number;
}

export interface MintedLedger {
  add(rec: MintedRecord): Promise<void>;
  get(cellId: string): Promise<MintedRecord | undefined>;
  all(): Promise<readonly MintedRecord[]>;
  citing(sourceCellId: string): Promise<readonly MintedRecord[]>;
  markForgotten(cellId: string, atEpoch: number, because: string, attestation?: DestructionAttestation): Promise<void>;
  setAttestation(cellId: string, attestation: DestructionAttestation): Promise<void>;
  setShareError(cellId: string, error: string | undefined): Promise<void>;
  lineageOf(cellId: string): readonly string[] | undefined;
  retirements(): ReadonlyMap<string, string>;
}

export class InMemoryMintedLedger implements MintedLedger {
  protected readonly records = new Map<string, MintedRecord>();
  protected readonly order: string[] = [];

  async add(rec: MintedRecord): Promise<void> {
    if (this.records.has(rec.cellId)) throw new Error(`minted ledger: ${rec.cellId.slice(0, 12)}… is already recorded — a mint is recorded once`);
    this.records.set(rec.cellId, rec);
    this.order.push(rec.cellId);
    await this.persist();
  }
  async get(cellId: string): Promise<MintedRecord | undefined> {
    return this.records.get(cellId);
  }
  async all(): Promise<readonly MintedRecord[]> {
    return this.order.map((id) => this.records.get(id)!);
  }
  async citing(sourceCellId: string): Promise<readonly MintedRecord[]> {
    return (await this.all()).filter((r) => r.forgotten === undefined && r.sources.some((s) => s.cellId === sourceCellId));
  }
  async markForgotten(cellId: string, atEpoch: number, because: string, attestation?: DestructionAttestation): Promise<void> {
    const r = this.records.get(cellId);
    if (r === undefined) throw new Error(`minted ledger: cannot mark unknown ${cellId.slice(0, 12)}… forgotten`);
    if (r.forgotten !== undefined) return;
    if (attestation !== undefined) checkAttestation(attestation);
    this.records.set(cellId, { ...r, forgotten: { atEpoch, because }, ...(attestation !== undefined ? { attestation } : {}) });
    await this.persist();
  }
  async setAttestation(cellId: string, attestation: DestructionAttestation): Promise<void> {
    const r = this.records.get(cellId);
    if (r === undefined) throw new Error(`minted ledger: unknown ${cellId.slice(0, 12)}…`);
    if (r.forgotten === undefined) throw new Error(`minted ledger: ${cellId.slice(0, 12)}… is not forgotten — an attestation follows a forget`);
    checkAttestation(attestation);
    this.records.set(cellId, { ...r, attestation });
    await this.persist();
  }
  async setShareError(cellId: string, error: string | undefined): Promise<void> {
    const r = this.records.get(cellId);
    if (r === undefined) throw new Error(`minted ledger: unknown ${cellId.slice(0, 12)}…`);
    const { shareError: _drop, ...rest } = r;
    this.records.set(cellId, error === undefined ? rest : { ...rest, shareError: error });
    await this.persist();
  }
  lineageOf(cellId: string): readonly string[] | undefined {
    const r = this.records.get(cellId);
    return r === undefined ? undefined : r.sources.map((s) => s.cellId);
  }
  retirements(): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const id of this.order) {
      const r = this.records.get(id)!;
      if (r.forgotten !== undefined || r.retires === undefined) continue;
      for (const src of r.retires) out.set(src, r.cellId);
    }
    return out;
  }
  protected async persist(): Promise<void> {}
}

export class FileMintedLedger extends InMemoryMintedLedger {
  private loaded = false;
  constructor(private readonly path: string) {
    super();
    assertStateDir("FileMintedLedger", dirname(path));
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    assertStateDir("FileMintedLedger", dirname(this.path));
    let raw: string | undefined;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") { this.loaded = true; return; }
      throw e;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { records?: unknown }).records)) {
      throw new Error(`minted ledger: ${this.path} is not a ledger file — refusing to start clean over a record that has no other source`);
    }
    for (const r of (parsed as { records: MintedRecord[] }).records) {
      if (typeof r?.cellId !== "string" || !Array.isArray(r.sources)) throw new Error(`minted ledger: malformed record in ${this.path}`);
      if (r.attestation !== undefined && (r.forgotten === undefined || !isAttestation(r.attestation))) throw new Error(`minted ledger: malformed attestation in ${this.path}`);
      this.records.set(r.cellId, r);
      this.order.push(r.cellId);
    }
    this.loaded = true;
  }

  protected override async persist(): Promise<void> {
    await ensureStateDir("FileMintedLedger", dirname(this.path));
    await writeFileAtomic(this.path, JSON.stringify({ version: 1, records: await this.all() }));
  }
}

const STATES: ReadonlySet<string> = new Set(["pending", "attested", "not-found"]);

function isAttestation(a: unknown): a is DestructionAttestation {
  if (typeof a !== "object" || a === null) return false;
  const { state, tries } = a as Record<string, unknown>;
  return typeof state === "string" && STATES.has(state) && Number.isSafeInteger(tries) && (tries as number) >= 1;
}

function checkAttestation(a: DestructionAttestation): void {
  if (!isAttestation(a)) throw new Error("minted ledger: an attestation is a known state and a whole number of tries from 1");
}
