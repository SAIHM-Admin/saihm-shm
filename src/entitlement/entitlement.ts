export const PAID_SUBSCRIPTION_TIERS: readonly string[] = Object.freeze(["PRO", "PRO_FAST", "ENTERPRISE", "ENTERPRISE_FAST"]);

export function isPaidSubscriptionTier(tier: unknown): tier is string {
  return typeof tier === "string" && PAID_SUBSCRIPTION_TIERS.includes(tier);
}

export interface SubscriptionSource {
  status(): Promise<unknown>;
}

export type EntitlementRefusal = "no-source" | "status-failed" | "status-timeout" | "unpaid-tier" | "unknown-tier";

export class EntitlementError extends Error {
  readonly code: EntitlementRefusal;
  readonly tier: string | undefined;
  readonly cause?: unknown;
  constructor(code: EntitlementRefusal, message: string, tier?: string, cause?: unknown) {
    super(message);
    this.name = "EntitlementError";
    this.code = code;
    this.tier = tier;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface Entitlement {
  readonly tier: string;
  readonly checkedAt: string;
  readonly status?: Readonly<Record<string, unknown>>;
}

export interface CheckEntitlementOptions {
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export const DEFAULT_ENTITLEMENT_TIMEOUT_MS = 15_000;

const PREFIX = "SHM requires a paid SAIHM subscription (" + PAID_SUBSCRIPTION_TIERS.join(", ") + ")";
const TIMED_OUT: unique symbol = Symbol("timed out");

function shown(tier: string): string {
  return JSON.stringify(tier.length > 40 ? `${tier.slice(0, 40)}…` : tier);
}

export async function checkEntitlement(source: SubscriptionSource | undefined, opts: CheckEntitlementOptions = {}): Promise<Entitlement> {
  const noSource = () => new EntitlementError("no-source", `${PREFIX}; no subscription source was given to confirm one. Pass your SAIHM client (or McpSaihmClient) as \`entitlement\`.`);
  if (typeof source !== "object" || source === null) throw noSource();
  let status: unknown;
  try {
    status = (source as { status?: unknown }).status;
  } catch (e) {
    throw new EntitlementError("status-failed", `${PREFIX}; the subscription source could not be read, so none could be confirmed.`, undefined, e);
  }
  if (typeof status !== "function") throw noSource();
  const call = status as (this: SubscriptionSource) => Promise<unknown>;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ENTITLEMENT_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`checkEntitlement: timeoutMs must be a positive finite number of milliseconds, got ${String(timeoutMs)}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tier: unknown;
  let reportedStatus: Readonly<Record<string, unknown>> | undefined;
  try {
    const reported = await Promise.race([
      Promise.resolve().then(() => call.call(source)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (typeof reported === "object" && reported !== null && !Array.isArray(reported)) reportedStatus = reported as Readonly<Record<string, unknown>>;
    tier = reportedStatus !== undefined ? reportedStatus["tier"] : undefined;
  } catch (e) {
    if (e === TIMED_OUT) {
      throw new EntitlementError(
        "status-timeout",
        `${PREFIX}; the SAIHM status call did not answer within ${timeoutMs} ms, so none could be confirmed. ` +
          "A first start of the SAIHM MCP server after an install or upgrade can take longer while it downloads: start it once beforehand, or raise entitlementTimeoutMs.",
      );
    }
    throw new EntitlementError("status-failed", `${PREFIX}; the SAIHM status call failed, so none could be confirmed.`, undefined, e);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (isPaidSubscriptionTier(tier)) {
    return Object.freeze({ tier, checkedAt: (opts.now ?? (() => new Date()))().toISOString(), ...(reportedStatus !== undefined ? { status: reportedStatus } : {}) });
  }
  if (tier === "FREE") {
    throw new EntitlementError("unpaid-tier", `${PREFIX}; this account's tier is FREE.`, tier);
  }
  if (typeof tier === "string") {
    throw new EntitlementError("unknown-tier", `${PREFIX}; SAIHM reported the tier ${shown(tier)}, which this release does not recognise as paid.`, tier);
  }
  throw new EntitlementError("unknown-tier", `${PREFIX}; the SAIHM status carried no tier, so none could be confirmed.`);
}
