export type HostEventName = "UserPromptSubmit" | "PreToolUse";

export const HOST_EVENT_FIELDS: Readonly<Record<HostEventName, readonly string[]>> = {
  UserPromptSubmit: ["hook_event_name", "session_id", "transcript_path", "prompt", "user_input"],
  PreToolUse: ["hook_event_name", "session_id", "transcript_path", "tool_name", "tool_input"],
};

interface EventBase {
  readonly sessionId?: string;
  readonly transcriptPath?: string;
}

export interface PromptEvent extends EventBase {
  readonly kind: "prompt";
  readonly eventName: "UserPromptSubmit";
  readonly prompt: string;
}

export interface ActionEvent extends EventBase {
  readonly kind: "action";
  readonly eventName: "PreToolUse";
  readonly toolName: string;
  readonly toolInput: unknown;
}

export type HostEvent = PromptEvent | ActionEvent;

const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const own = (o: Record<string, unknown>, k: string): unknown =>
  Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

function eventNameOf(p: Record<string, unknown>): HostEventName | undefined {
  const n = own(p, "hook_event_name");
  return n === "UserPromptSubmit" || n === "PreToolUse" ? n : undefined;
}

export function parseHostEvent(payload: unknown): HostEvent | undefined {
  if (!isPlainObject(payload)) return undefined;
  const eventName = eventNameOf(payload);
  if (eventName === undefined) return undefined;
  const sid = own(payload, "session_id");
  const tp = own(payload, "transcript_path");
  const base: EventBase = {
    ...(typeof sid === "string" && SESSION_ID.test(sid) ? { sessionId: sid } : {}),
    ...(typeof tp === "string" && tp !== "" ? { transcriptPath: tp } : {}),
  };
  if (eventName === "UserPromptSubmit") {
    const a = own(payload, "prompt");
    const b = own(payload, "user_input");
    const prompt = (typeof a === "string" && a.trim() !== "" ? a : typeof b === "string" ? b : "").trim();
    return prompt === "" ? undefined : { kind: "prompt", eventName, prompt, ...base };
  }
  const name = own(payload, "tool_name");
  const toolName = typeof name === "string" ? name.trim() : "";
  return toolName === "" ? undefined : { kind: "action", eventName, toolName, toolInput: own(payload, "tool_input"), ...base };
}

export function forwardableEvent(payload: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(payload)) return undefined;
  const eventName = eventNameOf(payload);
  if (eventName === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of HOST_EVENT_FIELDS[eventName]) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) out[k] = payload[k];
  }
  return out;
}
