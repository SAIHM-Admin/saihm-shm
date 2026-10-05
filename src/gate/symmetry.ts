import { gateScope, renderGateVerdict, type GateScope } from "./scope.js";

function decide<T>(predicate: (v: T) => boolean, value: T): boolean | undefined {
  try {
    return predicate(value) === true;
  } catch {
    return undefined;
  }
}

export interface SiftResult<T> {
  readonly kept: readonly T[];
  readonly dropped: readonly T[];
  readonly threw: number;
}

export interface SymmetricGuard<T> {
  readonly predicate: (v: T) => boolean;
  readonly name: string;
  admit(value: T): T;
  sift(values: Iterable<T>): SiftResult<T>;
}

export function bindSymmetric<T>(name: string, predicate: (v: T) => boolean): SymmetricGuard<T> {
  if (typeof name !== "string") throw new TypeError("bindSymmetric: name must be a string label");
  const label = name.trim();
  if (label.length === 0) throw new RangeError("bindSymmetric: name must be a non-empty label");
  if (typeof predicate !== "function") throw new TypeError("bindSymmetric: predicate must be a function");

  return {
    name: label,
    predicate,
    admit(value: T): T {
      const ok = decide(predicate, value);
      if (ok === true) return value;
      const why = ok === undefined ? "its validity check threw" : "its own reader would drop it";
      throw new TypeError(
        `${label}: refusing to accept this value on write because ${why}. Persisting it would ` +
          `succeed here and lose the data silently at the next read.`,
      );
    },
    sift(values: Iterable<T>): SiftResult<T> {
      const kept: T[] = [];
      const dropped: T[] = [];
      let threw = 0;
      for (const v of values) {
        const ok = decide(predicate, v);
        if (ok === true) kept.push(v);
        else {
          dropped.push(v);
          if (ok === undefined) threw++;
        }
      }
      return { kept, dropped, threw };
    },
  };
}

export interface AsymmetryProbe<T> {
  readonly unit: string;
  readonly samples: Iterable<T>;
  readonly writeAccepts: (v: T) => boolean;
  readonly readAccepts: (v: T) => boolean;
}

export interface AsymmetryReport<T> {
  readonly unit: string;
  readonly examined: number;
  readonly agreed: number;
  readonly silentLoss: readonly T[];
  readonly overStrict: readonly T[];
  readonly undecidable: readonly T[];
  readonly scope: GateScope;
  readonly symmetric: boolean;
  readonly verdict: string;
}

export function probeAsymmetry<T>(probe: AsymmetryProbe<T>): AsymmetryReport<T> {
  if (typeof probe.unit !== "string") throw new TypeError("probeAsymmetry: unit must be a string");
  const unit = probe.unit.trim();
  if (unit.length === 0) throw new RangeError("probeAsymmetry: unit must be a non-empty name");

  const silentLoss: T[] = [];
  const overStrict: T[] = [];
  const undecidable: T[] = [];
  let examined = 0;
  let agreed = 0;
  let discriminating = 0;

  for (const v of probe.samples) {
    examined++;
    const w = decide(probe.writeAccepts, v);
    const r = decide(probe.readAccepts, v);
    if (w === undefined || r === undefined) {
      undecidable.push(v);
      discriminating++;
      continue;
    }
    if (!w || !r) discriminating++;
    if (w === r) agreed++;
    else if (w) silentLoss.push(v);
    else overStrict.push(v);
  }

  const scope = gateScope({
    unit,
    examined,
    discriminating,
    discriminator: "were refused by at least one side, so could have revealed a disagreement",
  });
  const symmetric = silentLoss.length === 0 && overStrict.length === 0;
  const head = renderGateVerdict(symmetric, scope, { pass: "SYMMETRIC", fail: "ASYMMETRIC" });
  const detail = [
    silentLoss.length > 0 ? `${silentLoss.length} SILENT DATA LOSS (write accepts, read drops)` : "",
    overStrict.length > 0 ? `${overStrict.length} over-strict writer (write refuses, read accepts)` : "",
    undecidable.length > 0 ? `${undecidable.length} undecidable (a predicate threw)` : "",
  ].filter((s) => s.length > 0);

  return {
    unit,
    examined,
    agreed,
    silentLoss,
    overStrict,
    undecidable,
    scope,
    symmetric,
    verdict: detail.length > 0 ? `${head} · ${detail.join(" · ")}` : head,
  };
}

export interface RoundTripProbe<T, W> {
  readonly unit: string;
  readonly samples: Iterable<T>;
  readonly write: (v: T) => W;
  readonly read: (w: W) => T;
  readonly equals?: (a: T, b: T) => boolean;
}

export interface RoundTripMutation<T> {
  readonly wrote: T;
  readonly read: T;
}

export interface RoundTripReport<T> {
  readonly unit: string;
  readonly examined: number;
  readonly preserved: number;
  readonly mutated: readonly RoundTripMutation<T>[];
  readonly refused: readonly T[];
  readonly unreadable: readonly T[];
  readonly scope: GateScope;
  readonly faithful: boolean;
  readonly verdict: string;
}

export function probeRoundTrip<T, W>(probe: RoundTripProbe<T, W>): RoundTripReport<T> {
  if (typeof probe.unit !== "string") throw new TypeError("probeRoundTrip: unit must be a string");
  const unit = probe.unit.trim();
  if (unit.length === 0) throw new RangeError("probeRoundTrip: unit must be a non-empty name");
  const same = probe.equals ?? ((a: T, b: T): boolean => Object.is(a, b));

  const mutated: RoundTripMutation<T>[] = [];
  const refused: T[] = [];
  const unreadable: T[] = [];
  let examined = 0;
  let preserved = 0;

  for (const v of probe.samples) {
    examined++;
    let written: W;
    try {
      written = probe.write(v);
    } catch {
      refused.push(v);
      continue;
    }
    let back: T;
    try {
      back = probe.read(written);
    } catch {
      unreadable.push(v);
      continue;
    }
    if (same(v, back)) preserved++;
    else mutated.push({ wrote: v, read: back });
  }

  const scope = gateScope({
    unit,
    examined,
    discriminating: examined - refused.length,
    discriminator: "were accepted by the writer, so a mutation on read could have been observed",
  });
  const faithful = mutated.length === 0 && unreadable.length === 0;
  const head = renderGateVerdict(faithful, scope, { pass: "FAITHFUL", fail: "MUTATES" });
  const detail = [
    mutated.length > 0 ? `${mutated.length} SILENTLY REWRITTEN on read (accepted, then changed)` : "",
    unreadable.length > 0 ? `${unreadable.length} unreadable after a successful write` : "",
    refused.length > 0 ? `${refused.length} refused on write (loud, not a fidelity defect)` : "",
  ].filter((s) => s.length > 0);

  return {
    unit,
    examined,
    preserved,
    mutated,
    refused,
    unreadable,
    scope,
    faithful,
    verdict: detail.length > 0 ? `${head} · ${detail.join(" · ")}` : head,
  };
}
