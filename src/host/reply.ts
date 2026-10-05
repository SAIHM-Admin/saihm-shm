import type { HostEventName } from "./event.js";

export interface HostHookReply<E extends string = HostEventName> {
  readonly hookSpecificOutput: {
    readonly hookEventName: E;
    readonly additionalContext: string;
  };
}

export function hostReply<E extends string>(eventName: E, additionalContext: string): HostHookReply<E> {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext } };
}

export function sanitizeHostReply<E extends string>(value: unknown, expected: E, maxChars: number): HostHookReply<E> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const hso = Object.prototype.hasOwnProperty.call(value, "hookSpecificOutput")
    ? (value as Record<string, unknown>)["hookSpecificOutput"]
    : undefined;
  if (typeof hso !== "object" || hso === null || Array.isArray(hso)) return undefined;
  const o = hso as Record<string, unknown>;
  const name = Object.prototype.hasOwnProperty.call(o, "hookEventName") ? o["hookEventName"] : undefined;
  const ctx = Object.prototype.hasOwnProperty.call(o, "additionalContext") ? o["additionalContext"] : undefined;
  if (name !== expected) return undefined;
  if (typeof ctx !== "string" || ctx.trim() === "" || ctx.length > maxChars) return undefined;
  return hostReply(expected, ctx);
}

export function serializeHostReply(reply: HostHookReply<string>): string {
  return `${JSON.stringify(hostReply(reply.hookSpecificOutput.hookEventName, reply.hookSpecificOutput.additionalContext))}\n`;
}
