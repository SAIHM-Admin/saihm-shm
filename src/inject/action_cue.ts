export interface ActionCueOptions {
  readonly maxChars?: number;
  readonly maxDepth?: number;
}

export const DEFAULT_ACTION_CUE: Required<ActionCueOptions> = { maxChars: 600, maxDepth: 4 };

export interface PendingAction {
  readonly name: string;
  readonly input: unknown;
}

function collectStrings(v: unknown, depth: number, maxDepth: number, out: string[], seen: WeakSet<object>, cap: number): void {
  if (out.join(" ").length >= cap) return;
  if (depth > maxDepth) return;
  if (typeof v === "string") {
    const t = v.replace(/\s+/g, " ").trim();
    if (t !== "") out.push(t);
    return;
  }
  if (v === null || typeof v !== "object" || depth > maxDepth) return;
  if (seen.has(v)) return;
  seen.add(v);
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, depth + 1, maxDepth, out, seen, cap);
    return;
  }
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    collectStrings((v as Record<string, unknown>)[k], depth + 1, maxDepth, out, seen, cap);
  }
}

export function deriveActionCue(action: PendingAction | null | undefined, opts: ActionCueOptions = {}): string {
  const maxChars =
    Number.isFinite(opts.maxChars) && (opts.maxChars as number) >= 1 ? Math.floor(opts.maxChars as number) : DEFAULT_ACTION_CUE.maxChars;
  const maxDepth =
    Number.isFinite(opts.maxDepth) && (opts.maxDepth as number) >= 0 ? Math.floor(opts.maxDepth as number) : DEFAULT_ACTION_CUE.maxDepth;
  const parts: string[] = [];
  const a: Partial<PendingAction> = typeof action === "object" && action !== null ? action : {};
  let name = "";
  try {
    const n = a.name;
    name = typeof n === "string" ? n.replace(/\s+/g, " ").trim() : "";
  } catch {
  }
  if (name !== "") parts.push(name);
  try {
    collectStrings(a.input, 0, maxDepth, parts, new WeakSet(), maxChars);
  } catch {
  }
  const joined = parts.join(" ");
  return joined.length > maxChars ? joined.slice(0, maxChars).trimEnd() : joined;
}
