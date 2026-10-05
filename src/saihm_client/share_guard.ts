import { verifyBinding } from "../coordination/identity.js";
import type { ShareOptions, ShareRecipient, ShareScope } from "./types.js";
import { SaihmTransportError } from "./types.js";

const HEX64 = /^[0-9a-f]{64}$/;
const SCOPES: ReadonlySet<string> = new Set(["read", "write", "readwrite"]);

export const EPOCH_HOUR_MS = 3_600_000;
export const MAX_EXPIRY_HOURS_AHEAD = 1_000_000;

export function hourEpochNow(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / EPOCH_HOUR_MS);
}

export function expiryEpochHoursFromNow(hours: number, nowMs: number = Date.now()): string {
  if (!Number.isInteger(hours) || hours < 1) throw new RangeError(`expiryEpochHoursFromNow: hours must be a positive integer, got ${String(hours)}`);
  return String(hourEpochNow(nowMs) + hours);
}

export function guardExpiry(expiryEpoch: string | undefined, nowHours: number): void {
  if (expiryEpoch === undefined) return;
  if (typeof expiryEpoch !== "string" || !/^[0-9]{1,20}$/.test(expiryEpoch)) {
    throw new SaihmTransportError(`share refused: expiryEpoch must be a decimal count of HOURS since 1970, got ${JSON.stringify(expiryEpoch)}`);
  }
  const e = Number(expiryEpoch);
  if (e <= nowHours) {
    throw new SaihmTransportError(`share refused: expiryEpoch ${expiryEpoch} is not in the future (the protocol's hour is ${nowHours}) — the grant would lapse at once`);
  }
  if (e > nowHours + MAX_EXPIRY_HOURS_AHEAD) {
    throw new SaihmTransportError(
      `share refused: expiryEpoch ${expiryEpoch} is more than ${MAX_EXPIRY_HOURS_AHEAD} hours ahead — the protocol counts HOURS since 1970 (now ${nowHours}), so this reads as seconds or milliseconds and the grant would never lapse; write it as expiryEpochHoursFromNow(hours)`,
    );
  }
}

export function guardShare(recipient: ShareRecipient, scope: ShareScope, opts: ShareOptions = {}, nowMs: number = Date.now()): string {
  const id = typeof recipient.agentIdHash === "string" ? recipient.agentIdHash.trim().toLowerCase() : "";
  if (!HEX64.test(id)) {
    throw new SaihmTransportError(`share refused: recipient agentIdHash is not 64 hex characters (${JSON.stringify(recipient.agentIdHash)})`);
  }
  if (!SCOPES.has(scope)) throw new SaihmTransportError(`share refused: unknown scope ${JSON.stringify(scope)}`);
  if (recipient.record !== undefined) {
    const v = verifyBinding(id, recipient.record);
    if (!v.ok) throw new SaihmTransportError(`share refused: recipient record does not bind to ${id.slice(0, 8)}… — ${v.reason}`);
  }
  guardExpiry(opts.expiryEpoch, hourEpochNow(nowMs));
  return id;
}

export function guardContent(content: string, maxChars: number): string {
  if (typeof content !== "string" || content.trim() === "") throw new SaihmTransportError("remember refused: empty content");
  if (content.includes("\u0000")) throw new SaihmTransportError("remember refused: content contains a NUL byte");
  if (content.length > maxChars) throw new SaihmTransportError(`remember refused: content is ${content.length} chars, over the ${maxChars} limit for this transport`);
  return content;
}
