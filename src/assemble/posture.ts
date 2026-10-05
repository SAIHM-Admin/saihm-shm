export interface PosturePin {
  readonly cellId: string;
  readonly ingestEpoch?: number;
}

export interface PostureMemory {
  readonly lastShownEpoch?: number;
  readonly seen?: Readonly<Record<string, number | null>>;
}

export type PostureReason = "moved" | "unseen" | "gap" | "first-render";

export interface PostureDecision {
  readonly present: readonly PosturePin[];
  readonly reason?: PostureReason;
  readonly moved: readonly string[];
  readonly unseen: readonly string[];
  readonly held: number;
  readonly sinceShown?: number;
  readonly next?: PostureMemory;
}

export interface PostureGateOptions {
  readonly refreshAfter: number;
}

export function decidePosture(
  pins: readonly PosturePin[],
  nowEpoch: number,
  memory: PostureMemory | undefined,
  opts: PostureGateOptions,
): PostureDecision {
  const byId = new Map<string, PosturePin>();
  for (const p of pins) if (!byId.has(p.cellId)) byId.set(p.cellId, p);
  const distinct = [...byId.values()];

  if (distinct.length === 0) {
    return { present: [], moved: [], unseen: [], held: 0 };
  }

  const seen = memory?.seen ?? {};
  const versionOf = (p: PosturePin): number | null =>
    p.ingestEpoch === undefined || !Number.isFinite(p.ingestEpoch)
      ? null
      : p.ingestEpoch;

  const unseen = distinct
    .filter((p) => !Object.prototype.hasOwnProperty.call(seen, p.cellId))
    .map((p) => p.cellId);
  const moved = distinct
    .filter(
      (p) =>
        Object.prototype.hasOwnProperty.call(seen, p.cellId) &&
        seen[p.cellId] !== versionOf(p),
    )
    .map((p) => p.cellId);

  const last = memory?.lastShownEpoch;
  const clockUsable = Number.isFinite(nowEpoch);
  const lastUsable = last !== undefined && Number.isFinite(last);
  const raw: unknown = opts.refreshAfter;
  const window =
    typeof raw === "number" &&
    (Number.isFinite(raw) || raw === Number.POSITIVE_INFINITY)
      ? raw
      : 0;
  const gap =
    !clockUsable || !lastUsable || nowEpoch < (last as number)
      ? true
      : nowEpoch - (last as number) >= window;

  if (moved.length === 0 && unseen.length === 0 && !gap) {
    const since = nowEpoch - (last as number);
    return {
      present: [],
      moved,
      unseen,
      held: distinct.length,
      ...(Number.isFinite(since) ? { sinceShown: since } : {}),
    };
  }

  const everShown = lastUsable || Object.keys(seen).length > 0;
  const reason: PostureReason =
    moved.length > 0
      ? "moved"
      : unseen.length > 0 && everShown
        ? "unseen"
        : everShown
          ? "gap"
          : "first-render";

  const nextSeen: Record<string, number | null> = Object.fromEntries(
    distinct.map((p) => [p.cellId, versionOf(p)] as const),
  );

  return {
    present: distinct,
    reason,
    moved,
    unseen,
    held: distinct.length,
    ...(lastUsable && clockUsable && nowEpoch >= (last as number)
      ? { sinceShown: nowEpoch - (last as number) }
      : {}),
    next: clockUsable
      ? { lastShownEpoch: nowEpoch, seen: nextSeen }
      : {
          ...(lastUsable ? { lastShownEpoch: last as number } : {}),
          seen: nextSeen,
        },
  };
}
