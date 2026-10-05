import { existsSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { isAbsolute } from "node:path";
import { forwardableEvent, type HostEventName } from "./event.js";
import { sanitizeHostReply, serializeHostReply } from "./reply.js";
import { forwardableSessionStart } from "./session_start_event.js";
import { socketPathProblem } from "./socket_path.js";

export type HostHookTarget = { readonly port: number } | { readonly socketPath: string };

export interface HostHookClientOptions {
  readonly target: HostHookTarget;
  readonly input: AsyncIterable<Buffer | string> | string;
  readonly output: { write(chunk: string): unknown };
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxReplyBytes?: number;
  readonly offFile?: string;
  readonly projectDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type HostHookClientOutcome =
  | "off"
  | "foreign-project"
  | "bad-options"
  | "input-too-large"
  | "not-an-event"
  | "unreachable"
  | "timeout"
  | "no-reply"
  | "refused-status"
  | "reply-too-large"
  | "invalid-reply"
  | "written"
  | "fault";

const posIntElse = (v: number | undefined, dflt: number): number =>
  Number.isInteger(v) && (v as number) > 0 ? (v as number) : dflt;

function checkTarget(t: HostHookTarget): HostHookTarget | undefined {
  if ("socketPath" in t) {
    const ok = typeof t.socketPath === "string" && isAbsolute(t.socketPath) && socketPathProblem(t.socketPath) === undefined;
    return ok ? { socketPath: t.socketPath } : undefined;
  }
  return Number.isInteger(t.port) && t.port >= 1 && t.port <= 65535 ? { port: t.port } : undefined;
}

async function readBounded(input: AsyncIterable<Buffer | string> | string, max: number): Promise<string | undefined> {
  if (typeof input === "string") return Buffer.byteLength(input, "utf8") > max ? undefined : input;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of input) {
    const b = typeof c === "string" ? Buffer.from(c, "utf8") : c;
    size += b.length;
    if (size > max) return undefined;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const TIMED_OUT = Symbol("timed-out");

function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

type Exchange = { readonly status: number; readonly text: string } | "unreachable" | "timeout" | "reply-too-large";

function post(target: HostHookTarget, path: string, body: string, timeoutMs: number, maxReply: number): Promise<Exchange> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: Exchange): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const req = request(
      {
        method: "POST",
        path,
        headers: {
          host: "port" in target ? `127.0.0.1:${target.port}` : "localhost",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body, "utf8"),
          connection: "close",
        },
        createConnection: () =>
          "port" in target ? connect({ host: "127.0.0.1", port: target.port }) : connect({ path: target.socketPath }),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxReply) {
            done("reply-too-large");
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => done({ status, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => done("unreachable"));
      },
    );
    const timer = setTimeout(() => {
      done("timeout");
      req.destroy();
    }, timeoutMs);
    req.on("error", () => done("unreachable"));
    req.end(body);
  });
}

export async function runHostHook(opts: HostHookClientOptions): Promise<HostHookClientOutcome> {
  try {
    if (typeof opts.offFile === "string" && opts.offFile !== "" && existsSync(opts.offFile)) return "off";
    if (opts.projectDir !== undefined && (opts.env ?? process.env)["CLAUDE_PROJECT_DIR"] !== opts.projectDir) return "foreign-project";
    const target = checkTarget(opts.target);
    const path = opts.path ?? "/hook";
    if (target === undefined || !/^\/[A-Za-z0-9._~\/-]*$/.test(path)) return "bad-options";
    const timeoutMs = posIntElse(opts.timeoutMs, 2000);
    const text = await within(readBounded(opts.input, posIntElse(opts.maxInputBytes, 8 * 1024 * 1024)), timeoutMs);
    if (text === TIMED_OUT) return "timeout";
    if (text === undefined) return "input-too-large";
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return "not-an-event";
    }
    const forward = forwardableEvent(payload) ?? forwardableSessionStart(payload);
    if (forward === undefined) return "not-an-event";
    const eventName = forward["hook_event_name"] as HostEventName | "SessionStart";
    const maxReply = posIntElse(opts.maxReplyBytes, 1024 * 1024);
    const ex = await post(target, path, JSON.stringify(forward), timeoutMs, maxReply);
    if (typeof ex === "string") return ex;
    if (ex.status === 204 || (ex.status === 200 && ex.text.trim() === "")) return "no-reply";
    if (ex.status !== 200) return "refused-status";
    let parsed: unknown;
    try {
      parsed = JSON.parse(ex.text);
    } catch {
      return "invalid-reply";
    }
    const reply = sanitizeHostReply(parsed, eventName, maxReply);
    if (reply === undefined) return "invalid-reply";
    opts.output.write(serializeHostReply(reply));
    return "written";
  } catch {
    return "fault";
  }
}
