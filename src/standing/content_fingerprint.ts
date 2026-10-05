import { createHash } from "node:crypto";
import type { BodySource } from "../answer/types.js";
import type { LabelLookup } from "../rerank/reranking_retriever.js";
import { recallStanding, verifyStandingAnswer } from "./standing_answers.js";
import type {
  FingerprintLookup,
  StandingAnswer,
  StandingAnswerStore,
  StandingCandidate,
  StandingRecallConfig,
  StandingVerdict,
} from "./standing_answers.js";

export type FingerprintScope = "label" | "label+body";

const SCOPE_TAG: Readonly<Record<FingerprintScope, string>> = { label: "l1", "label+body": "lb1" };

export function contentFingerprint(label: string, body?: string): string {
  const h = createHash("sha256");
  const part = (s: string) => {
    h.update(`${Buffer.byteLength(s, "utf8")}:`, "utf8");
    h.update(s, "utf8");
  };
  part(label);
  if (body !== undefined) part(body);
  const scope: FingerprintScope = body === undefined ? "label" : "label+body";
  return `${SCOPE_TAG[scope]}:${h.digest("hex")}`;
}

export function fingerprintScope(fingerprint: string): FingerprintScope | undefined {
  const tag = fingerprint.slice(0, fingerprint.indexOf(":"));
  if (tag === SCOPE_TAG["label+body"]) return "label+body";
  if (tag === SCOPE_TAG.label) return "label";
  return undefined;
}

export interface FingerprintIndexConfig {
  readonly bodies?: BodySource;
}

export class ContentFingerprintIndex {
  private readonly prints = new Map<string, string>();
  private readonly bodies: BodySource | undefined;
  private refreshes = 0;
  private bodyFailures = 0;

  constructor(
    private readonly labelOf: LabelLookup,
    cfg: FingerprintIndexConfig = {},
  ) {
    this.bodies = cfg.bodies;
  }

  get stats(): { readonly refreshes: number; readonly bodyFailures: number } {
    return { refreshes: this.refreshes, bodyFailures: this.bodyFailures };
  }

  get size(): number {
    return this.prints.size;
  }

  async refresh(cellIds: readonly string[]): Promise<void> {
    const ids = [...new Set(cellIds)];
    if (ids.length === 0) return;
    this.refreshes++;

    let bodyById = new Map<string, string>();
    if (this.bodies) {
      try {
        const fetched = await this.bodies.fetchByIds(ids);
        const wanted = new Set(ids);
        bodyById = new Map(
          fetched
            .filter((b) => b.partial !== true && wanted.has(b.cellId))
            .map((b) => [b.cellId, b.plaintext] as const),
        );
      } catch {
        this.bodyFailures++;
      }
    }

    for (const id of ids) {
      let label: string | undefined;
      try {
        label = this.labelOf(id);
      } catch {
        label = undefined;
      }
      const body = bodyById.get(id);
      if (label === undefined) {
        this.prints.delete(id);
        continue;
      }
      if (label === "" && body === undefined) {
        this.prints.delete(id);
        continue;
      }
      this.prints.set(id, contentFingerprint(label, body));
    }
  }

  readonly lookup: FingerprintLookup = (cellId: string) => this.prints.get(cellId);

  forget(cellId: string): void {
    this.prints.delete(cellId);
  }
}

export async function verifyStandingAnswerLive(
  answer: StandingAnswer,
  index: ContentFingerprintIndex,
): Promise<StandingVerdict> {
  await index.refresh(answer.evidence.map((e) => e.cellId));
  return verifyStandingAnswer(answer, index.lookup);
}

const RESOLVES_NOTHING: FingerprintLookup = () => undefined;

export async function recallStandingLive(
  retrievedCellIds: readonly string[],
  store: StandingAnswerStore,
  index: ContentFingerprintIndex,
  cfg: StandingRecallConfig = {},
): Promise<readonly StandingCandidate[]> {
  const provisional = recallStanding(retrievedCellIds, store, RESOLVES_NOTHING, cfg);
  if (provisional.length === 0) return provisional;
  await index.refresh(provisional.flatMap((c) => c.answer.evidence.map((e) => e.cellId)));
  return recallStanding(retrievedCellIds, store, index.lookup, cfg);
}
