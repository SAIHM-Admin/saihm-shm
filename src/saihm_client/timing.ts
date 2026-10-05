import { isFeatureLabel, type LatencyObjective } from "./server_features.js";

export type Admission = "reserved" | "shared";

export interface Timing {
  readonly serverMs: number | null;
  readonly totalMs: number;
  readonly admission: Admission | null;
}

export type TimingRead =
  | { readonly kind: "present"; readonly timing: Timing }
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "malformed"; readonly field: string; readonly reason: string };

export const DEFAULT_SAMPLES_PER_OPERATION = 4096;
export const DEFAULT_MAX_OPERATIONS = 32;
export const SAMPLES_PER_OPERATION_LIMIT = 1_048_576;
export const OPERATIONS_LIMIT = 1024;
export const DEFAULT_MIN_ATTAINMENT_SAMPLES = 20;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);
const isMillis = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

const absentTiming = (reason: string): TimingRead => Object.freeze({ kind: "absent" as const, reason });
const malformedTiming = (field: string, reason: string): TimingRead => Object.freeze({ kind: "malformed" as const, field, reason });

export function parseTiming(toolResult: unknown): TimingRead {
  try {
    if (!isObject(toolResult)) return absentTiming("the tool result is not an object, so it carries no timing");
    const raw = own(toolResult, "timing");
    if (raw === undefined) return absentTiming("the tool result carries no timing");
    if (raw === null) return absentTiming("timing is null");
    if (!isObject(raw)) return malformedTiming("timing", "timing is not an object");
    const totalMs = own(raw, "totalMs");
    if (totalMs === undefined) return malformedTiming("timing.totalMs", "timing.totalMs is missing");
    if (!isMillis(totalMs)) return malformedTiming("timing.totalMs", "timing.totalMs is not a finite, non-negative number of milliseconds");
    const serverMs = own(raw, "serverMs");
    if (serverMs === undefined) return malformedTiming("timing.serverMs", "timing.serverMs is missing (null states that the service gave no time)");
    if (serverMs !== null && !isMillis(serverMs)) {
      return malformedTiming("timing.serverMs", "timing.serverMs is not null or a finite, non-negative number of milliseconds");
    }
    if (serverMs !== null && serverMs > totalMs) return malformedTiming("timing.serverMs", "timing.serverMs is larger than timing.totalMs, which contains it");
    const admission = own(raw, "admission");
    if (admission === undefined) return malformedTiming("timing.admission", "timing.admission is missing (null states that the service did not say)");
    if (admission !== null && admission !== "reserved" && admission !== "shared") {
      return malformedTiming("timing.admission", 'timing.admission is not "reserved", "shared" or null');
    }
    return Object.freeze({ kind: "present" as const, timing: Object.freeze({ serverMs, totalMs, admission }) });
  } catch {
    return malformedTiming("timing", "timing could not be read");
  }
}

export function nearestRank(n: number, p: number): number {
  if (!Number.isSafeInteger(n) || n < 1 || typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p > 100) return Number.NaN;
  const x = (p * n) / 100;
  const whole = Math.round(x);
  const rank = Math.abs(x - whole) <= RANK_TOLERANCE ? whole : Math.ceil(x);
  return Math.min(n, Math.max(1, rank));
}
const RANK_TOLERANCE = 1e-9;

export interface Percentiles {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface AdmissionCounts {
  readonly all: number;
  readonly reserved: number;
  readonly shared: number;
  readonly unknown: number;
}

export interface OperationTimingReport {
  readonly operation: string;
  readonly counts: AdmissionCounts;
  readonly totalMs: Percentiles | null;
  readonly serverMs: Percentiles | null;
  readonly networkMs: Percentiles | null;
  readonly windowHeld: boolean;
}

export type RecordRefusal = "operation" | "timing" | "time" | "operation-limit";

export type RecordOutcome = { readonly recorded: true } | { readonly recorded: false; readonly refusal: RecordRefusal };

export interface TimingReport {
  readonly fromMs: number;
  readonly toMs: number;
  readonly operations: readonly OperationTimingReport[];
  readonly refused: { readonly operation: number; readonly timing: number; readonly time: number; readonly operationLimit: number };
}

export type AttainmentGap =
  | "no-reserved-samples"
  | "insufficient-samples"
  | "window-not-held"
  | "entry-unusable";

interface AttainmentBase {
  readonly operation: string;
  readonly percentile: number;
  readonly thresholdMs: number;
  readonly n: number;
}

export type ObjectiveAttainment =
  | (AttainmentBase & { readonly observedMs: number; readonly met: boolean })
  | (AttainmentBase & { readonly observedMs: null; readonly met: null; readonly reason: AttainmentGap });

export interface TimingCollectorOptions {
  readonly samplesPerOperation?: number;
  readonly maxOperations?: number;
}

export interface AttainmentOptions {
  readonly minSamples?: number;
}

const ADMISSION_UNKNOWN = 0;
const ADMISSION_RESERVED = 1;
const ADMISSION_SHARED = 2;

const RECORDED: RecordOutcome = Object.freeze({ recorded: true as const });

interface Ring {
  readonly at: Float64Array;
  readonly total: Float64Array;
  readonly server: Float64Array;
  readonly admission: Uint8Array;
  next: number;
  size: number;
  newestOverwrittenAt: number;
}

function newRing(capacity: number): Ring {
  return {
    at: new Float64Array(capacity),
    total: new Float64Array(capacity),
    server: new Float64Array(capacity),
    admission: new Uint8Array(capacity),
    next: 0,
    size: 0,
    newestOverwrittenAt: Number.NEGATIVE_INFINITY,
  };
}

function checkedSample(timing: unknown): { readonly total: number; readonly server: number; readonly admission: number } | null {
  try {
    if (!isObject(timing)) return null;
    const total = own(timing, "totalMs");
    const server = own(timing, "serverMs");
    const admission = own(timing, "admission");
    if (!isMillis(total)) return null;
    if (server !== null && (!isMillis(server) || server > total)) return null;
    const code =
      admission === "reserved" ? ADMISSION_RESERVED : admission === "shared" ? ADMISSION_SHARED : admission === null ? ADMISSION_UNKNOWN : -1;
    if (code < 0) return null;
    return { total, server: server === null ? Number.NaN : server, admission: code };
  } catch {
    return null;
  }
}

function percentiles(values: Float64Array): Percentiles | null {
  const n = values.length;
  if (n === 0) return null;
  values.sort();
  const at = (p: number): number => values[nearestRank(n, p) - 1]!;
  return Object.freeze({ n, p50: at(50), p95: at(95), p99: at(99) });
}

function requireNow(nowMs: number): void {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) throw new RangeError("TimingCollector: nowMs must be a finite number of milliseconds");
}

function requireWholeOption(name: string, value: number, limit: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > limit) {
    throw new RangeError(`TimingCollector: ${name} must be a whole number from 1 to ${limit}`);
  }
  return value;
}

export class TimingCollector {
  readonly samplesPerOperation: number;
  readonly maxOperations: number;
  private readonly rings = new Map<string, Ring>();
  private readonly refusals = { operation: 0, timing: 0, time: 0, operationLimit: 0 };

  constructor(opts: TimingCollectorOptions = {}) {
    this.samplesPerOperation = requireWholeOption("samplesPerOperation", opts.samplesPerOperation ?? DEFAULT_SAMPLES_PER_OPERATION, SAMPLES_PER_OPERATION_LIMIT);
    this.maxOperations = requireWholeOption("maxOperations", opts.maxOperations ?? DEFAULT_MAX_OPERATIONS, OPERATIONS_LIMIT);
  }

  private refuse(refusal: RecordRefusal): RecordOutcome {
    if (refusal === "operation-limit") this.refusals.operationLimit++;
    else this.refusals[refusal]++;
    return Object.freeze({ recorded: false as const, refusal });
  }

  record(operation: string, timing: Timing, atMs: number): RecordOutcome {
    if (!isFeatureLabel(operation)) return this.refuse("operation");
    const sample = checkedSample(timing);
    if (sample === null) return this.refuse("timing");
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) return this.refuse("time");
    let ring = this.rings.get(operation);
    if (ring === undefined) {
      if (this.rings.size >= this.maxOperations) return this.refuse("operation-limit");
      ring = newRing(this.samplesPerOperation);
      this.rings.set(operation, ring);
    }
    const slot = ring.next;
    if (ring.size === this.samplesPerOperation) {
      const overwritten = ring.at[slot]!;
      if (overwritten > ring.newestOverwrittenAt) ring.newestOverwrittenAt = overwritten;
    } else {
      ring.size++;
    }
    ring.at[slot] = atMs;
    ring.total[slot] = sample.total;
    ring.server[slot] = sample.server;
    ring.admission[slot] = sample.admission;
    ring.next = (slot + 1) % this.samplesPerOperation;
    return RECORDED;
  }

  report(nowMs: number, windowMs: number): TimingReport {
    requireNow(nowMs);
    if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError("TimingCollector: windowMs must be a finite number of milliseconds above 0");
    }
    const fromMs = nowMs - windowMs;
    const operations = [...this.rings.keys()].sort().map((operation) => this.summarize(operation, this.rings.get(operation)!, fromMs, nowMs));
    return Object.freeze({ fromMs, toMs: nowMs, operations: Object.freeze(operations), refused: Object.freeze({ ...this.refusals }) });
  }

  private summarize(operation: string, ring: Ring, fromMs: number, toMs: number): OperationTimingReport {
    let reserved = 0;
    let shared = 0;
    let unknown = 0;
    const totals: number[] = [];
    const servers: number[] = [];
    const networks: number[] = [];
    for (let i = 0; i < ring.size; i++) {
      const at = ring.at[i]!;
      if (!(at > fromMs && at <= toMs)) continue;
      const admission = ring.admission[i]!;
      if (admission === ADMISSION_RESERVED) reserved++;
      else if (admission === ADMISSION_SHARED) shared++;
      else unknown++;
      const total = ring.total[i]!;
      const server = ring.server[i]!;
      totals.push(total);
      if (!Number.isNaN(server)) {
        servers.push(server);
        networks.push(total - server);
      }
    }
    return Object.freeze({
      operation,
      counts: Object.freeze({ all: totals.length, reserved, shared, unknown }),
      totalMs: percentiles(Float64Array.from(totals)),
      serverMs: percentiles(Float64Array.from(servers)),
      networkMs: percentiles(Float64Array.from(networks)),
      windowHeld: ring.newestOverwrittenAt <= fromMs,
    });
  }

  attainment(objective: LatencyObjective, nowMs: number, opts: AttainmentOptions = {}): readonly ObjectiveAttainment[] {
    requireNow(nowMs);
    const minSamples = opts.minSamples ?? DEFAULT_MIN_ATTAINMENT_SAMPLES;
    if (!Number.isSafeInteger(minSamples) || minSamples < 1) throw new RangeError("TimingCollector: minSamples must be a whole number above 0");
    if (minSamples > this.samplesPerOperation) {
      throw new RangeError("TimingCollector: minSamples is above samplesPerOperation, so no verdict could ever be given");
    }
    const isValue = typeof objective === "object" && objective !== null;
    const entries: unknown = isValue ? objective.objectives : undefined;
    const windowMs: unknown = isValue ? objective.windowMs : undefined;
    if (!Array.isArray(entries) || typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new TypeError("TimingCollector: attainment needs a latency objective: the value of an available parseLatencyObjective read");
    }
    return Object.freeze(entries.map((entry: unknown) => this.judge(entry, windowMs, nowMs, minSamples)));
  }

  private judge(entry: unknown, windowMs: number, nowMs: number, minSamples: number): ObjectiveAttainment {
    const e = isObject(entry) ? entry : {};
    const operation = typeof e["operation"] === "string" ? e["operation"] : "";
    const percentile = typeof e["percentile"] === "number" ? e["percentile"] : Number.NaN;
    const thresholdMs = typeof e["thresholdMs"] === "number" ? e["thresholdMs"] : Number.NaN;
    const gap = (n: number, reason: AttainmentGap): ObjectiveAttainment =>
      Object.freeze({ operation, percentile, thresholdMs, n, observedMs: null, met: null, reason });
    const usablePercentile = Number.isFinite(percentile) && percentile > 0 && percentile <= 100;
    if (!isFeatureLabel(operation) || !usablePercentile || !Number.isSafeInteger(thresholdMs) || thresholdMs <= 0) {
      return gap(0, "entry-unusable");
    }
    const fromMs = nowMs - windowMs;
    const ring = this.rings.get(operation);
    const compared: number[] = [];
    if (ring !== undefined) {
      for (let i = 0; i < ring.size; i++) {
        const at = ring.at[i]!;
        const server = ring.server[i]!;
        if (at > fromMs && at <= nowMs && ring.admission[i] === ADMISSION_RESERVED && !Number.isNaN(server)) compared.push(server);
      }
    }
    const n = compared.length;
    if (n === 0) return gap(0, "no-reserved-samples");
    if (n < minSamples) return gap(n, "insufficient-samples");
    if (ring !== undefined && ring.newestOverwrittenAt > fromMs) return gap(n, "window-not-held");
    const sorted = Float64Array.from(compared).sort();
    const observedMs = sorted[nearestRank(n, percentile) - 1]!;
    return Object.freeze({ operation, percentile, thresholdMs, n, observedMs, met: observedMs <= thresholdMs });
  }
}
