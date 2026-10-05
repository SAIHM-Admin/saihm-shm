export const MIN_CELLID_PREFIX = 8;

export const CELLID_ABBREV_SEP = "\u2026";

export type PrefixRefusal = "too-short" | "no-match" | "ambiguous" | "self";

export type PrefixResolution =
  | { readonly ok: true; readonly target: string }
  | {
      readonly ok: false;
      readonly reason: PrefixRefusal;
      readonly candidates?: readonly string[];
    };

export const NAMESPACE_SEPARATOR = "::";

interface Keyed {
  readonly lookup: string;
  readonly id: string;
}

export class CellIdPrefixIndex {
  readonly #buckets = new Map<string, Keyed[]>();
  readonly #exact = new Map<string, string[]>();

  constructor(ids: Iterable<string>, separator: string = NAMESPACE_SEPARATOR) {
    for (const raw of ids) {
      const id = raw.toLowerCase();
      const sep = separator.length > 0 ? id.indexOf(separator) : -1;
      const stem = sep > 0 ? id.slice(sep + separator.length) : undefined;
      for (const lookup of stem !== undefined && stem.length > 0 ? [id, stem] : [id]) {
        const ex = this.#exact.get(lookup);
        if (ex === undefined) this.#exact.set(lookup, [id]);
        else if (!ex.includes(id)) ex.push(id);
        if (lookup.length < MIN_CELLID_PREFIX) continue;
        const key = lookup.slice(0, MIN_CELLID_PREFIX);
        const bucket = this.#buckets.get(key);
        if (bucket === undefined) this.#buckets.set(key, [{ lookup, id }]);
        else bucket.push({ lookup, id });
      }
    }
  }

  resolveExact(ref: string, self?: string): PrefixResolution {
    const key = ref.toLowerCase();
    const all = this.#exact.get(key);
    if (all === undefined || all.length === 0) return { ok: false, reason: "no-match" };
    const selfLower = self?.toLowerCase();
    const others = selfLower === undefined ? all : all.filter((id) => id !== selfLower);
    if (others.length === 0) return { ok: false, reason: "self" };
    if (others.length > 1) return { ok: false, reason: "ambiguous", candidates: others };
    return { ok: true, target: others[0]! };
  }

  resolve(ref: string, self?: string): PrefixResolution {
    const [headRaw, tailRaw] = ref.toLowerCase().split("\u2026", 2);
    const p = headRaw ?? "";
    const tail = tailRaw === undefined || tailRaw === "" ? undefined : tailRaw;
    if (p.length < MIN_CELLID_PREFIX) return { ok: false, reason: "too-short" };

    const bucket = this.#buckets.get(p.slice(0, MIN_CELLID_PREFIX));
    if (bucket === undefined) return { ok: false, reason: "no-match" };

    const all = [...new Set(bucket.filter((k) => k.lookup.startsWith(p) && (tail === undefined || k.lookup.endsWith(tail))).map((k) => k.id))];
    if (all.length === 0) return { ok: false, reason: "no-match" };

    const selfLower = self?.toLowerCase();
    const others = selfLower === undefined ? all : all.filter((id) => id !== selfLower);
    if (others.length === 0) return { ok: false, reason: "self" };
    if (others.length > 1) return { ok: false, reason: "ambiguous", candidates: others };
    return { ok: true, target: others[0]! };
  }
}
