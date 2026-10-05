import { assertThreadPoolWithinRerank } from "../retrieval/thread_lifecycle.js";
import type { DemoteMode } from "../retrieval/thread_lifecycle.js";

export const HOT_SWAPPABLE_LEVERS = [
  "rerankK",
  "rerankOnBody",
  "rerankBodyWindowChars",
  "queryExpansion",
  "queryExpansionN",
  "queryExpansionM",
  "threadLifecycle",
  "threadJoin",
  "threadDemote",
  "threadPoolK",
  "threadMaxGroup",
  "allowThreadPoolWiderThanRerank",
] as const;

export const INDEX_TIME_LEVERS = ["rrf", "excludeNamespaces", "tenantId"] as const;

export type HotSwappableLever = (typeof HOT_SWAPPABLE_LEVERS)[number];

export interface LeverProfile {
  readonly rerankK?: number;
  readonly rerankOnBody?: boolean;
  readonly rerankBodyWindowChars?: number;
  readonly queryExpansion?: boolean;
  readonly queryExpansionN?: number;
  readonly queryExpansionM?: number;
  readonly threadLifecycle?: boolean;
  readonly threadJoin?: boolean;
  readonly threadDemote?: DemoteMode;
  readonly threadPoolK?: number;
  readonly threadMaxGroup?: number;
  readonly allowThreadPoolWiderThanRerank?: boolean;
}

export interface NormalizeLeverOptions {
  readonly hasReranker?: boolean;
}

export class LeverProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeverProfileError";
  }
}

export function normalizeLeverProfile(
  input: unknown,
  opts: NormalizeLeverOptions = {},
): LeverProfile {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new LeverProfileError(`lever profile must be an object, got ${Array.isArray(input) ? "array" : String(input === null ? "null" : typeof input)}`);
  }
  const raw = input as Record<string, unknown>;
  const allowed = new Set<string>(HOT_SWAPPABLE_LEVERS);
  const indexTime = new Set<string>(INDEX_TIME_LEVERS);

  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined) continue;
    if (indexTime.has(key)) {
      throw new LeverProfileError(
        `\`${key}\` is an INDEX-TIME lever and cannot be hot-swapped: it is consumed while building ` +
          `the index, so setting it in a per-agent or per-task profile would have no effect and no ` +
          `error. Change it by re-opening the session (vectors are loaded from the store, not ` +
          `re-embedded). Hot-swappable levers: ${HOT_SWAPPABLE_LEVERS.join(", ")}.`,
      );
    }
    if (!allowed.has(key)) {
      throw new LeverProfileError(
        `unknown lever \`${key}\`. Refused rather than ignored, because an ignored key is a lever ` +
          `that silently never applies. Hot-swappable levers: ${HOT_SWAPPABLE_LEVERS.join(", ")}.`,
      );
    }
  }

  assertThreadPoolWithinRerank({
    rerankK: raw["rerankK"],
    threadPoolK: raw["threadPoolK"],
    hasReranker: opts.hasReranker ?? true,
    allowWider: raw["allowThreadPoolWiderThanRerank"] === true,
  });

  return raw as LeverProfile;
}

export function isHotSwappable(lever: string): boolean {
  return (HOT_SWAPPABLE_LEVERS as readonly string[]).includes(lever);
}
