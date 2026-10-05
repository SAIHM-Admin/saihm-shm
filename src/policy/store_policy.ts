import { verifyBinding } from "../coordination/identity.js";

export type StoreTier = "local" | "saihm" | "central";
export type PolicyAuthority = "agent" | "central" | "hybrid";
export type OnUnavailable = "refuse-writes-keep-local-reads" | "refuse-all";

export interface StorePolicy {
  readonly version: 1;
  readonly authority: PolicyAuthority;
  readonly primary: StoreTier;
  readonly allowed: readonly StoreTier[];
  readonly onUnavailable: OnUnavailable;
  readonly organization?: string;
  readonly issuedAtEpoch?: number;
}

export interface ResolvedPolicy {
  readonly policy: StorePolicy;
  readonly provenance: "agent" | "central" | "degraded";
  readonly issuer?: string;
  readonly degraded?: string;
}

const TIERS: ReadonlySet<string> = new Set(["local", "saihm", "central"]);
const AUTH: ReadonlySet<string> = new Set(["agent", "central", "hybrid"]);
const ONU: ReadonlySet<string> = new Set(["refuse-writes-keep-local-reads", "refuse-all"]);
const HEX64 = /^[0-9a-f]{64}$/;

function bad(msg: string): never {
  throw new Error(`store policy: ${msg}`);
}

export function validateStorePolicy(raw: unknown): StorePolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad("not an object");
  const p = raw as Record<string, unknown>;
  if (p["version"] !== 1) bad(`unsupported version ${JSON.stringify(p["version"])}`);
  if (typeof p["authority"] !== "string" || !AUTH.has(p["authority"])) bad(`unknown authority ${JSON.stringify(p["authority"])}`);
  if (!Array.isArray(p["allowed"]) || p["allowed"].length === 0 || !p["allowed"].every((t) => typeof t === "string" && TIERS.has(t))) bad("allowed must be a non-empty list of tiers");
  const allowed = [...new Set(p["allowed"] as StoreTier[])];
  if (typeof p["primary"] !== "string" || !TIERS.has(p["primary"])) bad(`unknown primary ${JSON.stringify(p["primary"])}`);
  if (!allowed.includes(p["primary"] as StoreTier)) bad(`primary ${p["primary"]} is not in allowed [${allowed.join(",")}]`);
  if (typeof p["onUnavailable"] !== "string" || !ONU.has(p["onUnavailable"])) bad(`unknown onUnavailable ${JSON.stringify(p["onUnavailable"])}`);
  let organization: string | undefined;
  if (p["organization"] !== undefined) {
    if (typeof p["organization"] !== "string" || !HEX64.test(p["organization"])) bad("organization must be a 64-hex agentIdHash");
    organization = p["organization"];
  }
  if ((p["authority"] === "central" || p["authority"] === "hybrid") && organization === undefined) bad(`authority ${p["authority"]} requires an organization id`);
  let issuedAtEpoch: number | undefined;
  if (p["issuedAtEpoch"] !== undefined) {
    if (typeof p["issuedAtEpoch"] !== "number" || !Number.isFinite(p["issuedAtEpoch"]) || p["issuedAtEpoch"] < 0) bad("issuedAtEpoch must be a non-negative finite number");
    issuedAtEpoch = p["issuedAtEpoch"];
  }
  return {
    version: 1,
    authority: p["authority"] as PolicyAuthority,
    primary: p["primary"] as StoreTier,
    allowed,
    onUnavailable: p["onUnavailable"] as OnUnavailable,
    ...(organization !== undefined ? { organization } : {}),
    ...(issuedAtEpoch !== undefined ? { issuedAtEpoch } : {}),
  };
}

export const POLICY_MARKER = "SHM-POLICY:v1";

export function encodePolicyCell(policy: StorePolicy): string {
  return `${POLICY_MARKER}\n${JSON.stringify(validateStorePolicy(policy))}`;
}

export function parsePolicyCell(plaintext: string): StorePolicy | undefined {
  if (!plaintext.startsWith(POLICY_MARKER)) return undefined;
  const nl = plaintext.indexOf("\n");
  if (nl < 0) bad("policy marker with no body");
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext.slice(nl + 1));
  } catch {
    bad("policy body is not JSON");
  }
  return validateStorePolicy(raw);
}

export function degradedPolicy(reason: string, onUnavailable: OnUnavailable = "refuse-writes-keep-local-reads"): ResolvedPolicy {
  return {
    policy: { version: 1, authority: "central", primary: "local", allowed: ["local"], onUnavailable },
    provenance: "degraded",
    degraded: reason,
  };
}

export interface SharedCellReader {
  readShared?(sharerAgentIdHash: string, sharerRecord: { readonly mldsaPubKey: string; readonly mlkemPubKey: string; readonly mlkemPubKeySelfSig: string }, cellId: string): Promise<string | undefined>;
}

export type PolicySource =
  | { readonly kind: "agent"; readonly policy: StorePolicy }
  | {
      readonly kind: "central";
      readonly organization: string;
      readonly organizationRecord: { readonly mldsaPubKey: string; readonly mlkemPubKey: string; readonly mlkemPubKeySelfSig: string };
      readonly policyCellId: string;
      readonly agentPrimary?: StoreTier;
    };

export async function resolveStorePolicy(source: PolicySource, port: SharedCellReader): Promise<ResolvedPolicy> {
  if (source.kind === "agent") {
    return { policy: validateStorePolicy(source.policy), provenance: "agent" };
  }
  const org = source.organization.trim().toLowerCase();
  const bind = verifyBinding(org, source.organizationRecord);
  if (!bind.ok) return degradedPolicy(`organization record does not bind to the pinned id: ${bind.reason}`);
  if (typeof port.readShared !== "function") return degradedPolicy("this port cannot read a shared cell (no readShared) — central policy unreachable");
  let text: string | undefined;
  try {
    text = await port.readShared(org, source.organizationRecord, source.policyCellId);
  } catch (e) {
    return degradedPolicy(`policy cell read failed: ${(e as Error).message}`);
  }
  if (text === undefined) return degradedPolicy("policy cell not readable from the pinned organization");
  let policy: StorePolicy | undefined;
  try {
    policy = parsePolicyCell(text);
  } catch (e) {
    return degradedPolicy(`policy cell malformed: ${(e as Error).message}`);
  }
  if (policy === undefined) return degradedPolicy("the shared cell is not a policy cell");
  if (policy.authority === "agent") return degradedPolicy("a centrally shared policy declares authority `agent` — refused as contradictory");
  if (policy.organization !== undefined && policy.organization !== org) return degradedPolicy("policy names a different organization than the one pinned");
  let effective = policy;
  if (policy.authority === "hybrid" && source.agentPrimary !== undefined) {
    if (!policy.allowed.includes(source.agentPrimary)) return degradedPolicy(`agent primary ${source.agentPrimary} is outside allowed [${policy.allowed.join(",")}]`);
    effective = { ...policy, primary: source.agentPrimary };
  } else if (policy.authority === "central" && source.agentPrimary !== undefined && source.agentPrimary !== policy.primary) {
    return degradedPolicy("authority is central: the agent may not choose a primary");
  }
  return { policy: effective, provenance: "central", issuer: org };
}

export function assertWriteAllowed(resolved: ResolvedPolicy, tier: StoreTier, what: string): void {
  if (resolved.policy.allowed.includes(tier)) return;
  const why = resolved.provenance === "degraded" ? ` (degraded: ${resolved.degraded})` : "";
  throw new Error(`${what} refused: store policy does not allow writes to tier ${tier}${why}; allowed [${resolved.policy.allowed.join(",")}]`);
}
