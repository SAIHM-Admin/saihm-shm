import type { Namespace } from "../ingest/types.js";
import type { StampLookup } from "./thread_lifecycle.js";

export interface Scope {
  readonly name: string;
  readonly admits: (cellId: string) => boolean;
}

export interface SelectOpts {
  readonly maxK?: number;
  readonly asOfEpoch?: number;
  readonly scope?: Scope;
  readonly excludeRetired?: boolean;
}

export function admitsSafely(scope: Scope | undefined, cellId: string): boolean {
  if (scope === undefined) return true;
  try {
    return scope.admits(cellId) === true;
  } catch {
    return false;
  }
}

export function withPool(opts: SelectOpts | undefined, maxK: number): SelectOpts {
  return {
    maxK,
    ...(opts?.asOfEpoch !== undefined ? { asOfEpoch: opts.asOfEpoch } : {}),
    ...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts?.excludeRetired !== undefined ? { excludeRetired: opts.excludeRetired } : {}),
  };
}

export type AdmissionOpts = Pick<SelectOpts, "asOfEpoch" | "scope" | "excludeRetired">;

export function admissionOf(opts: SelectOpts | undefined): AdmissionOpts | undefined {
  if (opts?.asOfEpoch === undefined && opts?.scope === undefined && opts?.excludeRetired === undefined) return undefined;
  return {
    ...(opts.asOfEpoch !== undefined ? { asOfEpoch: opts.asOfEpoch } : {}),
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.excludeRetired !== undefined ? { excludeRetired: opts.excludeRetired } : {}),
  };
}

export interface LineageLookups {
  readonly isDerived: (cellId: string) => boolean;
  readonly lineageOf: (cellId: string) => readonly string[] | undefined;
  readonly maxDepth?: number;
}

export function withLineage(base: Scope, lookups: LineageLookups): Scope {
  const maxDepth = Number.isFinite(lookups.maxDepth) && (lookups.maxDepth as number) >= 1 ? Math.floor(lookups.maxDepth as number) : 16;
  const admitsAt = (cellId: string, depth: number, trail: Set<string>): boolean => {
    if (admitsSafely(base, cellId)) return true;
    let derived: boolean;
    try {
      derived = lookups.isDerived(cellId) === true;
    } catch {
      return false;
    }
    if (!derived) return false;
    if (depth >= maxDepth || trail.has(cellId)) return false;
    let sources: readonly string[] | undefined;
    try {
      sources = lookups.lineageOf(cellId);
    } catch {
      sources = undefined;
    }
    if (sources === undefined || sources.length === 0) return false;
    trail.add(cellId);
    try {
      return sources.every((s) => admitsAt(s, depth + 1, trail));
    } finally {
      trail.delete(cellId);
    }
  };
  return { name: `${base.name} ⊕lineage`, admits: (cellId) => admitsAt(cellId, 0, new Set()) };
}

export function composeScopes(...scopes: readonly Scope[]): Scope {
  if (scopes.length === 1) return scopes[0]!;
  return {
    name: scopes.length === 0 ? "all" : scopes.map((s) => s.name).join(" ∩ "),
    admits: (cellId) => scopes.every((s) => admitsSafely(s, cellId)),
  };
}

export interface ScopeSpec {
  readonly name?: string;
  readonly threads?: readonly string[];
  readonly kinds?: readonly string[];
  readonly namespaces?: readonly Namespace[];
  readonly cellIds?: readonly string[];
}

export interface ScopeLookups {
  readonly stampOf?: StampLookup;
  readonly namespaceOf?: (cellId: string) => Namespace | undefined;
}

export function scopeFrom(spec: ScopeSpec, lookups: ScopeLookups = {}): Scope {
  const threads = spec.threads === undefined ? undefined : new Set(spec.threads.map((t) => t.toLowerCase()));
  const kinds = spec.kinds === undefined ? undefined : new Set(spec.kinds.map((k) => k.toLowerCase()));
  const namespaces = spec.namespaces === undefined ? undefined : new Set(spec.namespaces);
  const cellIds = spec.cellIds === undefined ? undefined : new Set(spec.cellIds);
  if ((threads !== undefined || kinds !== undefined) && lookups.stampOf === undefined) {
    throw new Error("scopeFrom: a `threads`/`kinds` scope needs a `stampOf` lookup — refusing to build a scope that would admit everything");
  }
  if (namespaces !== undefined && lookups.namespaceOf === undefined) {
    throw new Error("scopeFrom: a `namespaces` scope needs a `namespaceOf` lookup — refusing to build a scope that would admit everything");
  }
  if (threads === undefined && kinds === undefined && namespaces === undefined && cellIds === undefined) {
    throw new Error("scopeFrom: a spec with no dimension is not a scope — pass no scope at all for unscoped recall");
  }
  const parts: string[] = [];
  if (threads) parts.push(`thread:${[...threads].join(",")}`);
  if (kinds) parts.push(`kind:${[...kinds].join(",")}`);
  if (namespaces) parts.push(`ns:${[...namespaces].join(",")}`);
  if (cellIds) parts.push(`cells:${cellIds.size}`);
  const stampOf = lookups.stampOf;
  const namespaceOf = lookups.namespaceOf;
  return {
    name: spec.name ?? parts.join(" · "),
    admits: (cellId) => {
      if (cellIds !== undefined && !cellIds.has(cellId)) return false;
      if (threads !== undefined) {
        const t = stampOf!(cellId).thread;
        if (t === undefined || !threads.has(t.toLowerCase())) return false;
      }
      if (kinds !== undefined) {
        const k = stampOf!(cellId).kind;
        if (k === undefined || !kinds.has(k.toLowerCase())) return false;
      }
      if (namespaces !== undefined) {
        const ns = namespaceOf!(cellId);
        if (ns === undefined || !namespaces.has(ns)) return false;
      }
      return true;
    },
  };
}
