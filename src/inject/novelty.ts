export interface InjectionCandidate {
  readonly cellId: string;
  readonly version?: string | number;
}

export type SuppressionReason = "already-in-context";

export interface SuppressedCandidate {
  readonly cellId: string;
  readonly reason: SuppressionReason;
}

export interface InjectionHistory {
  readonly shown?: Readonly<Record<string, string | number | null>>;
}

export interface NoveltyDecision {
  readonly novel: readonly InjectionCandidate[];
  readonly suppressed: readonly SuppressedCandidate[];
  readonly next?: InjectionHistory;
}

export function selectNovel(
  candidates: readonly InjectionCandidate[],
  history: InjectionHistory | undefined,
): NoveltyDecision {
  const shown = history?.shown ?? {};
  const versionOf = (c: InjectionCandidate): string | number | null =>
    c.version === undefined ||
    (typeof c.version === "number" && !Number.isFinite(c.version))
      ? null
      : c.version;

  const novel: InjectionCandidate[] = [];
  const suppressed: SuppressedCandidate[] = [];
  const seenThisTurn = new Set<string>();

  for (const c of candidates) {
    if (seenThisTurn.has(c.cellId)) continue;
    seenThisTurn.add(c.cellId);
    const priorKnown = Object.prototype.hasOwnProperty.call(shown, c.cellId);
    if (priorKnown && shown[c.cellId] === versionOf(c)) {
      suppressed.push({ cellId: c.cellId, reason: "already-in-context" });
      continue;
    }
    novel.push(c);
  }

  if (novel.length === 0) return { novel, suppressed };

  return {
    novel,
    suppressed,
    next: {
      shown: Object.fromEntries([
        ...Object.entries(shown),
        ...novel.map((c) => [c.cellId, versionOf(c)] as const),
      ]),
    },
  };
}
