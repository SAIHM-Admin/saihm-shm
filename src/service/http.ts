import { lstatSync, statSync, unlinkSync, chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { ServiceError, type ServiceHandlers } from "./handlers.js";
import type { ScopeSpec } from "../retrieval/scope.js";
import { serializeHostReply, type HostHookReply } from "../host/reply.js";
import { socketPathProblem } from "../host/socket_path.js";
import { buildInjectionContext } from "../answer/context.js";

export interface HostHookHandler {
  handle(payload: unknown): Promise<HostHookReply<string> | undefined>;
}

export interface HttpServiceOptions {
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly allowedHosts?: readonly string[];
  readonly socketPath?: string;
  readonly hook?: HostHookHandler;
}

export interface HttpService {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly socketPath?: string;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new ServiceError(413, `body exceeds ${maxBytes} bytes`);
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    throw new ServiceError(400, "body is not JSON");
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body) + "\n");
}

function noContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || LOOPBACK_V4.test(h);
}

const BROWSER_HEADERS = ["origin", "sec-fetch-site", "sec-fetch-dest", "sec-fetch-user"] as const;

export function requestRefusal(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  allowedHostHeaders: ReadonlySet<string> | undefined,
): "browser-origin" | "host" | undefined {
  for (const h of BROWSER_HEADERS) if (headers[h] !== undefined) return "browser-origin";
  if (allowedHostHeaders === undefined) return undefined;
  const host = headers["host"];
  if (typeof host !== "string" || !allowedHostHeaders.has(host.trim().toLowerCase())) return "host";
  return undefined;
}

export function loopbackHostHeaders(bindHost: string, port: number, extra: readonly string[] = []): Set<string> {
  const names = new Set(["127.0.0.1", "localhost", "[::1]"]);
  const b = bindHost.trim().toLowerCase();
  if (LOOPBACK_V4.test(b)) names.add(b);
  const out = new Set<string>();
  for (const n of names) {
    out.add(`${n}:${port}`);
    if (port === 80) out.add(n);
  }
  for (const e of extra) out.add(e.trim().toLowerCase());
  return out;
}

function socketDirProblem(path: string): string | undefined {
  if (!isAbsolute(path)) return "socketPath must be absolute";
  let st;
  try {
    st = statSync(dirname(path));
  } catch {
    return "socketPath directory does not exist";
  }
  if (!st.isDirectory()) return "socketPath directory is not a directory";
  if ((st.mode & 0o077) !== 0) return "socketPath directory must be closed to group and others (mode 0700 or tighter)";
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return "socketPath directory must be owned by this user";
  return undefined;
}

async function clearStaleSocket(path: string): Promise<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isSocket()) throw new Error("socketPath exists and is not a socket");
  const live = await new Promise<boolean>((resolve) => {
    const s = connect({ path });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
  if (live) throw new Error("socketPath is in use by a running service");
  unlinkSync(path);
}

export function listenOnSocket(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      let there = false;
      try {
        there = lstatSync(path).isSocket();
      } catch {
      }
      if (there) return resolve();
      server.close();
      reject(new Error("serveHttp: the runtime reported listening and no socket exists at socketPath — it bound another name; look for a stray socket in the directories above"));
    });
  });
}

export async function serveHttp(handlers: ServiceHandlers, opts: HttpServiceOptions = {}): Promise<HttpService> {
  const host = opts.host ?? "127.0.0.1";
  const maxBody = Number.isFinite(opts.maxBodyBytes) && (opts.maxBodyBytes as number) > 0 ? (opts.maxBodyBytes as number) : 1_048_576;
  const socketPath = opts.socketPath;
  if (socketPath !== undefined) {
    const problem = socketPathProblem(socketPath) ?? socketDirProblem(socketPath);
    if (problem !== undefined) throw new Error(`serveHttp: ${problem}`);
    await clearStaleSocket(socketPath);
  } else if (!isLoopbackHost(host) && (opts.allowedHosts === undefined || opts.allowedHosts.length === 0)) {
    throw new Error("serveHttp: a non-loopback host needs allowedHosts — the Host header check cannot be derived for it");
  }
  let allowed: ReadonlySet<string> | "socket" | "pending" = "pending";

  const server = createServer(async (req, res) => {
    if (allowed === "pending" || requestRefusal(req.headers, allowed === "socket" ? undefined : allowed) !== undefined) {
      res.writeHead(403, { "content-type": "application/json", connection: "close" });
      res.end('{"error":"forbidden"}\n');
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      if (method === "GET" && url.pathname === "/health") return json(res, 200, handlers.health());
      if (method === "GET" && url.pathname === "/recall") {
        const kRaw = url.searchParams.get("k");
        const asOfRaw = url.searchParams.get("asOfEpoch");
        return json(res, 200, await handlers.recall({
          q: url.searchParams.get("q") ?? "",
          ...(kRaw !== null ? { k: Number(kRaw) } : {}),
          ...(asOfRaw !== null ? { asOfEpoch: Number(asOfRaw) } : {}),
        }));
      }
      if (method === "POST" && url.pathname === "/hook" && opts.hook !== undefined) {
        let payload: Record<string, unknown>;
        try {
          payload = await readJson(req, maxBody);
        } catch {
          return noContent(res);
        }
        let reply: HostHookReply<string> | undefined;
        try {
          reply = await opts.hook.handle(payload);
        } catch {
          reply = undefined;
        }
        if (reply === undefined) return noContent(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(serializeHostReply(reply));
        return;
      }
      if (method === "POST" && url.pathname === "/inject") {
        const body = await readJson(req, maxBody);
        const r = await handlers.inject({ taskContext: String(body["taskContext"] ?? "") });
        if (r.injected.length === 0) return noContent(res);
        return json(res, 200, r);
      }
      if (method === "POST" && url.pathname === "/preact") {
        const body = await readJson(req, maxBody);
        const name = typeof body["name"] === "string" ? body["name"] : typeof body["tool_name"] === "string" ? body["tool_name"] : "";
        const input = "input" in body ? body["input"] : body["tool_input"];
        const r = await handlers.preact({ name, input });
        if (r === undefined) return noContent(res);
        const fenced = buildInjectionContext(
          r.result.injected
            .filter((m) => /^[^<>=\s]+$/.test(m.cellId))
            .map((m) => ({ cellId: m.cellId, plaintext: m.text, epoch: m.epoch, tier: m.tier, partial: m.partial })),
        );
        if (fenced.prompt === "") return noContent(res);
        return json(res, 200, { ...r, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: fenced.prompt } });
      }
      if (method === "GET" && url.pathname === "/threads") return json(res, 200, await handlers.threads());
      if (method === "GET" && url.pathname === "/thread") return json(res, 200, await handlers.thread({ slug: url.searchParams.get("slug") ?? "" }));
      if (method === "POST" && url.pathname === "/threads") {
        const body = await readJson(req, maxBody);
        return json(res, 200, await handlers.threads("spec" in body ? { spec: body["spec"] as ScopeSpec } : {}));
      }
      if (method === "POST" && url.pathname === "/thread") {
        const body = await readJson(req, maxBody);
        const slug = typeof body["slug"] === "string" ? body["slug"] : "";
        return json(res, 200, await handlers.thread("spec" in body ? { slug, spec: body["spec"] as ScopeSpec } : { slug }));
      }
      if (method === "POST" && url.pathname === "/census") {
        const body = await readJson(req, maxBody);
        return json(res, 200, await handlers.census(body["spec"] as ScopeSpec));
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof ServiceError) return json(res, e.status, { error: e.message });
      json(res, 500, { error: (e as Error).message });
    }
  });

  return new Promise((resolve, reject) => {
    const onListening = (): void => {
      let port = 0;
      if (socketPath !== undefined) {
        try {
          chmodSync(socketPath, 0o600);
        } catch {
        }
        allowed = "socket";
      } else {
        const addr = server.address();
        port = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? 0);
        allowed = loopbackHostHeaders(host, port, opts.allowedHosts ?? []);
      }
      resolve({
        server,
        host: socketPath !== undefined ? "" : host,
        port,
        ...(socketPath !== undefined ? { socketPath } : {}),
        close: () => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    };
    if (socketPath !== undefined) {
      listenOnSocket(server, socketPath).then(onListening, reject);
    } else {
      server.once("error", reject);
      server.listen(opts.port ?? 0, host, () => {
        server.off("error", reject);
        onListening();
      });
    }
  });
}
