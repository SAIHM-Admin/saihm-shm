import { createHash } from "node:crypto";

export interface AgentRecord {
  readonly mldsaPubKey: string;
  readonly mlkemPubKey?: string;
  readonly mlkemPubKeySelfSig?: string;
}

export type BindingVerdict =
  | { readonly ok: true; readonly agentIdHash: string; readonly note: string }
  | { readonly ok: false; readonly kind: "malformed" | "mismatch"; readonly reason: string };

const HEX_ID = /^[0-9a-fA-F]{64}$/;
const HEX_PAIRS = /^(?:[0-9a-fA-F]{2})+$/;

function unhexlify(hex: string): Buffer | null {
  if (!HEX_PAIRS.test(hex)) return null;
  const buf = Buffer.from(hex, "hex");
  return buf.length * 2 === hex.length ? buf : null;
}

export function verifyBinding(agentIdHash: string, record: AgentRecord): BindingVerdict {
  const id = agentIdHash.trim().toLowerCase();
  if (!HEX_ID.test(id)) {
    return { ok: false, kind: "malformed", reason: `agentIdHash is not 64 hex characters: ${JSON.stringify(agentIdHash)}` };
  }
  const raw: unknown = record.mldsaPubKey;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      kind: "malformed",
      reason: `record carries no usable mldsaPubKey (got ${raw === null ? "null" : typeof raw}) — nothing to bind against`,
    };
  }
  const key = raw.trim();
  const bytes = unhexlify(key);
  if (bytes === null) {
    return {
      ok: false,
      kind: "malformed",
      reason:
        `mldsaPubKey is not valid hex (${key.length} chars) — REFUSED rather than hashed, because a ` +
        `truncated decode produces a confident mismatch against a possibly-valid key`,
    };
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== id) {
    return { ok: false, kind: "mismatch", reason: `sha256(key) is ${actual}, record claims ${id}` };
  }
  return {
    ok: true,
    agentIdHash: id,
    note: "binding verified — this proves the key belongs to the id, NOT that the record is current",
  };
}

export interface DirectoryEntry {
  readonly name: string;
  readonly agentIdHash: string;
  readonly record?: AgentRecord;
  readonly note?: string;
}

export interface DeniedRoute {
  readonly agentIdHash: string;
  readonly reason: string;
}

export type RouteVerdict =
  | { readonly ok: true; readonly entry: DirectoryEntry; readonly agentIdHash: string; readonly note: string }
  | {
      readonly ok: false;
      readonly kind: "unknown" | "ambiguous" | "denied" | "unverified";
      readonly reason: string;
      readonly candidates?: readonly string[];
    };

const MIN_PREFIX = 8;

export function deniedBy(agentIdHash: string, denials: readonly DeniedRoute[]): DeniedRoute | undefined {
  const id = agentIdHash.trim().toLowerCase();
  for (const d of denials) {
    const p = d.agentIdHash.trim().toLowerCase();
    if (p.length < MIN_PREFIX) {
      throw new RangeError(
        `denylist entry ${JSON.stringify(d.agentIdHash)} is shorter than ${MIN_PREFIX} hex characters — ` +
          `a short prefix denies a whole neighbourhood of unrelated agents`,
      );
    }
    if (d.reason.trim().length === 0) {
      throw new RangeError(`denylist entry ${p} carries no reason — an unexplained denial is one the next reader deletes`);
    }
    if (id.startsWith(p)) return d;
  }
  return undefined;
}

export function resolveRecipient(
  name: string,
  directory: readonly DirectoryEntry[],
  denials: readonly DeniedRoute[] = [],
): RouteVerdict {
  const wanted = name.trim().toLowerCase();
  const matches = directory.filter((e) => e.name.trim().toLowerCase() === wanted);

  if (matches.length === 0) {
    return { ok: false, kind: "unknown", reason: `no directory entry named ${JSON.stringify(name)}` };
  }
  if (matches.length > 1) {
    const flagged = matches.map((m) => {
      const d = deniedBy(m.agentIdHash, denials);
      return `${m.agentIdHash.slice(0, 8)}${d === undefined ? "" : " [DENIED: " + d.reason + "]"}`;
    });
    return {
      ok: false,
      kind: "ambiguous",
      candidates: flagged,
      reason:
        `${matches.length} agents answer to ${JSON.stringify(name)} — refusing to guess. ` +
        `Address by agentIdHash: ${flagged.join(", ")}`,
    };
  }

  const entry = matches[0]!;
  const denied = deniedBy(entry.agentIdHash, denials);
  if (denied !== undefined) {
    return { ok: false, kind: "denied", reason: `route to ${entry.agentIdHash.slice(0, 8)} is denied: ${denied.reason}` };
  }
  if (entry.record === undefined) {
    return {
      ok: false,
      kind: "unverified",
      reason: `${entry.name} has no published record in this directory — the binding cannot be checked, so the route is refused`,
    };
  }
  const binding = verifyBinding(entry.agentIdHash, entry.record);
  if (!binding.ok) {
    return { ok: false, kind: "unverified", reason: `binding check failed for ${entry.name}: ${binding.reason}` };
  }
  return { ok: true, entry, agentIdHash: binding.agentIdHash, note: binding.note };
}
