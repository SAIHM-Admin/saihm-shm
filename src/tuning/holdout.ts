function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HoldoutOptions {
  readonly seed?: number;
  readonly heldOutFraction?: number;
  readonly groupOf?: (caseId: string) => string;
  readonly stratumOf?: (caseId: string) => string;
}

export interface StratumBalance {
  readonly discovery: number;
  readonly heldOut: number;
}

export interface Holdout<T> {
  readonly discovery: readonly T[];
  readonly heldOut: readonly T[];
  readonly groups: { readonly discovery: number; readonly heldOut: number; readonly straddling: number };
  readonly strata: ReadonlyMap<string, StratumBalance>;
  readonly degenerate: boolean;
  readonly warnings: readonly string[];
  readonly disclosure: string;
}

const DEFAULT_SEED = 20260902;

export function splitHoldout<T>(
  cases: readonly T[],
  idOf: (c: T) => string,
  opts: HoldoutOptions = {},
): Holdout<T> {
  const seed = opts.seed ?? DEFAULT_SEED;
  const frac = opts.heldOutFraction ?? 0.5;
  if (!Number.isFinite(frac) || frac <= 0 || frac >= 1) {
    throw new RangeError(`heldOutFraction must be strictly between 0 and 1, got ${String(opts.heldOutFraction)}`);
  }
  const groupOf: (caseId: string) => string = opts.groupOf ?? ((id) => id);
  const stratumOf = opts.stratumOf;

  const byGroup = new Map<string, T[]>();
  for (const c of cases) {
    const g = groupOf(idOf(c));
    let bucket = byGroup.get(g);
    if (!bucket) byGroup.set(g, (bucket = []));
    bucket.push(c);
  }

  const groupIds = [...byGroup.keys()].sort();
  const rand = rng(seed);
  for (let i = groupIds.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [groupIds[i], groupIds[j]] = [groupIds[j]!, groupIds[i]!];
  }

  const dominant = (members: readonly T[]): string => {
    if (!stratumOf) return "";
    const counts = new Map<string, number>();
    for (const m of members) {
      const s = stratumOf(idOf(m));
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
  };

  const discovery: T[] = [];
  const heldOut: T[] = [];
  let dGroups = 0;
  let hGroups = 0;
  const dStrat = new Map<string, number>();
  const hStrat = new Map<string, number>();

  for (const gid of groupIds) {
    const members = byGroup.get(gid)!;
    const s = dominant(members);
    const dSeen = dStrat.get(s) ?? 0;
    const hSeen = hStrat.get(s) ?? 0;
    const total = dSeen + hSeen;
    const toHeldOut = total === 0 ? frac >= 0.5 : hSeen < frac * total;
    if (toHeldOut) {
      heldOut.push(...members);
      hGroups++;
      hStrat.set(s, hSeen + members.length);
    } else {
      discovery.push(...members);
      dGroups++;
      dStrat.set(s, dSeen + members.length);
    }
  }

  const dIds = new Set(discovery.map((c) => groupOf(idOf(c))));
  const hIds = new Set(heldOut.map((c) => groupOf(idOf(c))));
  let straddling = 0;
  for (const g of dIds) if (hIds.has(g)) straddling++;
  if (straddling > 0) {
    throw new Error(
      `splitHoldout: ${straddling} group(s) straddle both sides, so the held-out half is not held ` +
        `out. This is a bug in the splitter, not a condition a caller can accept.`,
    );
  }
  if (discovery.length + heldOut.length !== cases.length) {
    throw new Error(
      `splitHoldout: ${discovery.length} + ${heldOut.length} != ${cases.length} cases; the split ` +
        `lost or duplicated cases.`,
    );
  }

  const strata = new Map<string, StratumBalance>();
  if (stratumOf) {
    for (const c of discovery) {
      const s = stratumOf(idOf(c));
      const cur = strata.get(s) ?? { discovery: 0, heldOut: 0 };
      strata.set(s, { discovery: cur.discovery + 1, heldOut: cur.heldOut });
    }
    for (const c of heldOut) {
      const s = stratumOf(idOf(c));
      const cur = strata.get(s) ?? { discovery: 0, heldOut: 0 };
      strata.set(s, { discovery: cur.discovery, heldOut: cur.heldOut + 1 });
    }
  }
  const warnings: string[] = [];
  if (heldOut.length === 0) warnings.push("held-out side is EMPTY — nothing can be reported from it");
  if (discovery.length === 0) warnings.push("discovery side is EMPTY — nothing can be tuned on it");
  if (byGroup.size < 2) warnings.push(`only ${byGroup.size} group(s) — a group-atomic split cannot divide them`);
  for (const [s, b] of strata) {
    if (b.discovery === 0 || b.heldOut === 0) {
      warnings.push(`stratum "${s}" appears on ONE side only (${b.discovery}/${b.heldOut}) — a per-stratum difference there is an artefact of the split`);
    }
  }

  const grouped = opts.groupOf ? `grouped by caller-supplied key` : `UNGROUPED (each case its own group — no leakage protection)`;
  const disclosure =
    `holdout: seed=${seed} frac=${frac} · ${discovery.length} discovery / ${heldOut.length} held-out cases ` +
    `· ${dGroups}/${hGroups} groups · ${grouped}` +
    (stratumOf ? ` · stratified best-effort on ${strata.size} strata` : ``);

  return {
    discovery,
    heldOut,
    groups: { discovery: dGroups, heldOut: hGroups, straddling },
    strata,
    degenerate: warnings.length > 0,
    warnings,
    disclosure,
  };
}

const MIN_COUNT_FOR_Z = 5;
const DEFAULT_Z_TOLERANCE = 3;

export interface StratumDeviation {
  readonly stratum: string;
  readonly population: number;
  readonly sampled: number;
  readonly populationShare: number;
  readonly sampledShare: number;
  readonly expected: number;
  readonly z: number | null;
}

export interface SampleBias {
  readonly n: number;
  readonly population: number;
  readonly strata: readonly StratumDeviation[];
  readonly biased: boolean;
  readonly measurable: boolean;
  readonly warnings: readonly string[];
  readonly disclosure: string;
}

export function sampleBias<T>(
  sample: readonly T[],
  population: readonly T[],
  stratumOf: (c: T) => string,
  opts: { readonly zTolerance?: number } = {},
): SampleBias {
  const tol = opts.zTolerance ?? DEFAULT_Z_TOLERANCE;
  if (!Number.isFinite(tol) || tol <= 0) {
    throw new RangeError(`zTolerance must be a positive finite number, got ${String(opts.zTolerance)}`);
  }
  const N = population.length;
  const n = sample.length;
  const popCount = new Map<string, number>();
  for (const c of population) popCount.set(stratumOf(c), (popCount.get(stratumOf(c)) ?? 0) + 1);
  const sampCount = new Map<string, number>();
  for (const c of sample) sampCount.set(stratumOf(c), (sampCount.get(stratumOf(c)) ?? 0) + 1);

  const warnings: string[] = [];
  for (const s of sampCount.keys()) {
    if (!popCount.has(s)) warnings.push(`stratum "${s}" is in the sample but NOT in the population — the sample is not a subset of what it is being judged against`);
  }

  const strata: StratumDeviation[] = [...popCount.keys()].sort().map((s) => {
    const pop = popCount.get(s)!;
    const samp = sampCount.get(s) ?? 0;
    const p = N === 0 ? 0 : pop / N;
    const expected = p * n;
    const sd = Math.sqrt((p * (1 - p)) / Math.max(1, n));
    const judgeable = Math.max(expected, samp) >= MIN_COUNT_FOR_Z && sd > 0 && n > 0;
    return {
      stratum: s,
      population: pop,
      sampled: samp,
      populationShare: p,
      sampledShare: n === 0 ? 0 : samp / n,
      expected,
      z: judgeable ? ((n === 0 ? 0 : samp / n) - p) / sd : null,
    };
  });

  const measurable = popCount.size > 1 && n > 0 && N > 0;
  const offenders = strata.filter((d) => d.z !== null && Math.abs(d.z) > tol);
  const biased = measurable && offenders.length > 0;

  if (!measurable) {
    warnings.push(
      popCount.size <= 1
        ? `only ${popCount.size} distinct stratum — this check CANNOT FAIL here and its verdict is vacuous`
        : `empty sample or population — nothing to judge`,
    );
  }
  for (const d of offenders) {
    warnings.push(
      `stratum "${d.stratum}": ${d.sampled}/${n} sampled (${(100 * d.sampledShare).toFixed(1)}%) vs ` +
        `${d.population}/${N} in population (${(100 * d.populationShare).toFixed(1)}%), expected ~${d.expected.toFixed(1)} — z=${d.z!.toFixed(2)}`,
    );
  }
  const unjudged = strata.filter((d) => d.z === null);
  if (unjudged.length > 0) {
    warnings.push(`${unjudged.length} stratum/strata too rare to judge at n=${n} (expected AND observed both < ${MIN_COUNT_FOR_Z}): ${unjudged.map((d) => d.stratum).join(", ")}`);
  }

  const verdict = !measurable ? "VACUOUS" : biased ? "BIASED" : "no deviation beyond tolerance";
  const disclosure =
    `sample: n=${n} of ${N} · ${popCount.size} strata · |z|>${tol} ⇒ biased · ${verdict}` +
    (offenders.length > 0 ? ` (${offenders.length} offending: ${offenders.map((d) => d.stratum).join(", ")})` : ``);

  return { n, population: N, strata, biased, measurable, warnings, disclosure };
}

export interface SampleResult<T> {
  readonly cases: readonly T[];
  readonly bias: SampleBias;
  readonly disclosure: string;
}

export function stratifiedSample<T>(
  population: readonly T[],
  n: number,
  stratumOf: (c: T) => string,
  opts: { readonly seed?: number } = {},
): SampleResult<T> {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`sample size must be a positive integer, got ${String(n)}`);
  const seed = opts.seed ?? DEFAULT_SEED;

  if (n >= population.length) {
    const all = [...population];
    return {
      cases: all,
      bias: sampleBias(all, population, stratumOf),
      disclosure: `sample: FULL POPULATION (${all.length}) — no sampling performed`,
    };
  }

  const byStratum = new Map<string, T[]>();
  for (const c of population) {
    const s = stratumOf(c);
    let b = byStratum.get(s);
    if (!b) byStratum.set(s, (b = []));
    b.push(c);
  }
  const keys = [...byStratum.keys()].sort();

  const quota = new Map<string, number>();
  const remainder: { s: string; frac: number }[] = [];
  let assigned = 0;
  for (const s of keys) {
    const exact = (byStratum.get(s)!.length / population.length) * n;
    const base = Math.floor(exact);
    quota.set(s, base);
    assigned += base;
    remainder.push({ s, frac: exact - base });
  }
  remainder.sort((a, b) => b.frac - a.frac || (a.s < b.s ? -1 : 1));
  for (let i = 0; assigned < n; i++, assigned++) {
    const s = remainder[i % remainder.length]!.s;
    quota.set(s, quota.get(s)! + 1);
  }

  const rand = rng(seed);
  const cases: T[] = [];
  for (const s of keys) {
    const members = [...byStratum.get(s)!];
    for (let i = members.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [members[i], members[j]] = [members[j]!, members[i]!];
    }
    cases.push(...members.slice(0, Math.min(quota.get(s)!, members.length)));
  }

  const bias = sampleBias(cases, population, stratumOf);
  return {
    cases,
    bias,
    disclosure: `sample: stratified n=${cases.length} of ${population.length} · seed=${seed} · ${keys.length} strata · ${bias.biased ? "STILL BIASED (see warnings)" : "mix tracks population"}`,
  };
}
