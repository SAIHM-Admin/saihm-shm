import type { Tier } from "../tiers/membership.js";

export const SERVICE_TIERS: readonly Tier[] = ["hot", "warm", "cold"];

export interface ServiceLevel {
  readonly p50Ms?: number;
  readonly p95Ms?: number;
  readonly minSamples?: number;
}

export interface LatencyStats {
  readonly n: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface ServiceLevelVerdict {
  readonly route: string;
  readonly declared: ServiceLevel;
  readonly observed?: LatencyStats;
  readonly within: boolean | undefined;
  readonly reason: string;
}

export interface TierLevelVerdict extends Omit<ServiceLevelVerdict, "route"> {
  readonly tier: Tier;
}

export const DEFAULT_MIN_SAMPLES = 20;

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0 || !Number.isFinite(p) || p <= 0 || p > 1) return Number.NaN;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

export class LatencyRecorder {
  private readonly buffers = new Map<string, { readonly ring: number[]; next: number; filled: boolean }>();
  constructor(private readonly capacity = 512) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`LatencyRecorder: capacity must be a positive integer, got ${capacity}`);
  }

  record(route: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let b = this.buffers.get(route);
    if (b === undefined) {
      b = { ring: new Array<number>(this.capacity), next: 0, filled: false };
      this.buffers.set(route, b);
    }
    b.ring[b.next] = ms;
    b.next = (b.next + 1) % this.capacity;
    if (b.next === 0) b.filled = true;
  }

  routes(): string[] {
    return [...this.buffers.keys()].sort();
  }

  stats(route: string): LatencyStats | undefined {
    const b = this.buffers.get(route);
    if (b === undefined) return undefined;
    const live = (b.filled ? b.ring : b.ring.slice(0, b.next)).filter((x): x is number => typeof x === "number");
    if (live.length === 0) return undefined;
    const sorted = [...live].sort((x, y) => x - y);
    return { n: sorted.length, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted[sorted.length - 1]! };
  }
}

export function evaluateServiceLevel(route: string, declared: ServiceLevel, observed: LatencyStats | undefined): ServiceLevelVerdict {
  const hasTarget = Number.isFinite(declared.p50Ms) || Number.isFinite(declared.p95Ms);
  if (!hasTarget) return { route, declared, ...(observed ? { observed } : {}), within: undefined, reason: "no target declared (p50Ms/p95Ms absent)" };
  const min = Number.isInteger(declared.minSamples) && (declared.minSamples as number) >= 1 ? (declared.minSamples as number) : DEFAULT_MIN_SAMPLES;
  if (observed === undefined || observed.n < min) {
    return { route, declared, ...(observed ? { observed } : {}), within: undefined, reason: `insufficient samples (${observed?.n ?? 0} < ${min}) — no verdict` };
  }
  const breaches: string[] = [];
  if (Number.isFinite(declared.p50Ms) && observed.p50Ms > (declared.p50Ms as number)) breaches.push(`p50 ${observed.p50Ms}ms > ${declared.p50Ms}ms`);
  if (Number.isFinite(declared.p95Ms) && observed.p95Ms > (declared.p95Ms as number)) breaches.push(`p95 ${observed.p95Ms}ms > ${declared.p95Ms}ms`);
  return breaches.length === 0
    ? { route, declared, observed, within: true, reason: `within level over ${observed.n} samples` }
    : { route, declared, observed, within: false, reason: breaches.join("; ") };
}

export function evaluateTierLevel(tier: Tier, declared: ServiceLevel, observed: LatencyStats | undefined): TierLevelVerdict {
  const { route: _route, ...verdict } = evaluateServiceLevel(tier, declared, observed);
  return { tier, ...verdict };
}
