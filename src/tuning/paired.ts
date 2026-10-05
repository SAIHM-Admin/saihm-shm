function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PairedComparison {
  readonly n: number;
  readonly delta: number;
  readonly meanA: number;
  readonly meanB: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly level: number;
  readonly resamples: number;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly signP: number | null;
  readonly excludesZero: boolean;
  readonly disclosure: string;
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

function signTest(wins: number, losses: number): number | null {
  const n = wins + losses;
  if (n === 0) return null;
  const lo = Math.min(wins, losses);
  let logSum = -Infinity;
  let logC = 0;
  for (let i = 0; i <= lo; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    const term = logC - n * Math.LN2;
    logSum = logSum === -Infinity ? term : Math.max(logSum, term) + Math.log1p(Math.exp(-Math.abs(logSum - term)));
  }
  return Math.min(1, 2 * Math.exp(logSum));
}

export function pairedCompare(
  a: readonly number[],
  b: readonly number[],
  opts: { readonly resamples?: number; readonly level?: number; readonly seed?: number } = {},
): PairedComparison {
  if (a.length !== b.length) {
    throw new RangeError(
      `pairedCompare: arms have ${a.length} and ${b.length} cases — they are not paired, and a ` +
        `difference between differently-sized sets is not the quantity this computes`,
    );
  }
  const n = a.length;
  if (n === 0) throw new RangeError("pairedCompare: no cases");
  const level = opts.level ?? 0.95;
  if (!(level > 0 && level < 1)) throw new RangeError(`level must be strictly between 0 and 1, got ${String(opts.level)}`);
  const B = opts.resamples ?? 2000;
  if (!Number.isInteger(B) || B < 100) throw new RangeError(`resamples must be an integer >= 100, got ${String(opts.resamples)}`);

  const d = a.map((x, i) => x - b[i]!);
  const delta = mean(d);

  let wins = 0, losses = 0, ties = 0;
  for (const x of d) { if (x > 0) wins++; else if (x < 0) losses++; else ties++; }

  const rand = rng(opts.seed ?? 20260902);
  const boots = new Array<number>(B);
  for (let bIdx = 0; bIdx < B; bIdx++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rand() * n)]!;
    boots[bIdx] = s / n;
  }
  boots.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  const at = (q: number): number => boots[Math.min(B - 1, Math.max(0, Math.floor(q * B)))]!;
  const ciLow = at(tail);
  const ciHigh = at(1 - tail);
  const excludesZero = (ciLow > 0 && ciHigh > 0) || (ciLow < 0 && ciHigh < 0);
  const signP = signTest(wins, losses);

  const disclosure =
    `paired n=${n} · Δ=${delta >= 0 ? "+" : ""}${delta.toFixed(4)} ` +
    `[${ciLow >= 0 ? "+" : ""}${ciLow.toFixed(4)}, ${ciHigh >= 0 ? "+" : ""}${ciHigh.toFixed(4)}] ` +
    `${(100 * level).toFixed(0)}% percentile bootstrap, B=${B} · ` +
    `W/L/T ${wins}/${losses}/${ties}` +
    (signP === null ? ` · sign test n/a (all tied)` : ` · sign p=${signP < 1e-4 ? signP.toExponential(1) : signP.toFixed(4)}`) +
    (excludesZero ? `` : ` · ⚠️ INTERVAL SPANS ZERO — not distinguished at this n`);

  return { n, delta, meanA: mean(a), meanB: mean(b), ciLow, ciHigh, level, resamples: B, wins, losses, ties, signP, excludesZero, disclosure };
}
