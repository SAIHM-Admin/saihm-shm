export function hourlyEpoch(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 3_600_000) : 0;
}

export const EPOCH_KEYS = ["updated", "date"] as const;

export function epochFromFrontmatter(frontmatter: ReadonlyMap<string, string>): number | undefined {
  for (const k of EPOCH_KEYS) {
    const v = frontmatter.get(k)?.trim();
    if (v === undefined || v === "") continue;
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > 0) return hourlyEpoch(ms);
  }
  return undefined;
}
