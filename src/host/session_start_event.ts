import { parseHostEvent } from "./event.js";

export type SessionStartSource = "startup" | "resume" | "clear" | "compact" | "fork" | "unknown";

const KNOWN_SOURCES: ReadonlySet<string> = new Set(["startup", "resume", "clear", "compact", "fork"]);

export const SESSION_START_FIELDS: readonly string[] = ["hook_event_name", "session_id", "transcript_path", "source"];

export interface SessionStartEvent {
  readonly kind: "session-start";
  readonly eventName: "SessionStart";
  readonly source: SessionStartSource;
  readonly sessionId?: string;
  readonly transcriptPath?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const own = (o: Record<string, unknown>, k: string): unknown =>
  Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

export function parseSessionStartEvent(payload: unknown): SessionStartEvent | undefined {
  if (!isPlainObject(payload) || own(payload, "hook_event_name") !== "SessionStart") return undefined;
  const ids = parseHostEvent({
    hook_event_name: "UserPromptSubmit",
    prompt: "session-start",
    session_id: own(payload, "session_id"),
    transcript_path: own(payload, "transcript_path"),
  });
  const src = own(payload, "source");
  const source: SessionStartSource =
    typeof src === "string" && KNOWN_SOURCES.has(src) ? (src as SessionStartSource) : "unknown";
  return {
    kind: "session-start",
    eventName: "SessionStart",
    source,
    ...(ids?.sessionId !== undefined ? { sessionId: ids.sessionId } : {}),
    ...(ids?.transcriptPath !== undefined ? { transcriptPath: ids.transcriptPath } : {}),
  };
}

export function forwardableSessionStart(payload: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(payload) || own(payload, "hook_event_name") !== "SessionStart") return undefined;
  const out: Record<string, unknown> = {};
  for (const k of SESSION_START_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) out[k] = payload[k];
  }
  return out;
}
