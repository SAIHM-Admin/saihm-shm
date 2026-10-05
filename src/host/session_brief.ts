import { buildInjectionContext } from "../answer/context.js";
import { encodeCheckpointText, latestCheckpoint, parseCheckpointText, readCheckpoint, type CheckpointState } from "../derived/checkpoint.js";
import type { MintedLedger } from "../derived/ledger.js";
import type { SaihmDerivedStore } from "../derived/store.js";
import { verifyResume, type Probe, type ResumeReport } from "../resume/resume.js";
import { hostReply, type HostHookReply } from "./reply.js";
import type { SessionAdmission } from "./sessions.js";
import { parseSessionStartEvent, type SessionStartSource } from "./session_start_event.js";

export const DEFAULT_BRIEF_MAX_CHARS = 6000;
export const DEFAULT_BRIEF_SOURCE_TIMEOUT_MS = 1500;

const NOTE_CHARS = 1500;
const LINE_CHARS = 300;
const SLUG_CHARS = 80;
const BRIEF_BLOCK_ID = "session-brief";

export interface SessionCheckpoint {
  readonly id: string;
  readonly state: CheckpointState;
}

export interface WorkstreamLine {
  readonly slug: string;
  readonly members: number;
  readonly status?: string;
}

export interface SessionStartBriefOptions {
  readonly admitSession: SessionAdmission;
  readonly checkpoint?: () => Promise<SessionCheckpoint | undefined>;
  readonly probes?: () => Promise<Readonly<Record<string, Probe>>>;
  readonly here?: string;
  readonly matches?: (stated: string, actual: string) => boolean;
  readonly workstreams?: () => Promise<readonly WorkstreamLine[]>;
  readonly sources?: readonly SessionStartSource[];
  readonly maxChars?: number;
  readonly sourceTimeoutMs?: number;
  readonly onBrief?: (record: SessionBriefRecord) => void;
}

export type BriefSection = "shown" | "none" | "unavailable" | "not-configured";

export interface SessionBriefRecord {
  readonly eventName: "SessionStart";
  readonly source: SessionStartSource;
  readonly outcome: "fired" | "off" | "silent" | "error";
  readonly reason?: "no-session-binding" | "foreign-session" | "source-not-served" | "nothing-configured" | "too-small" | "fault";
  readonly checkpoint: BriefSection;
  readonly checkpointFault?: SourceFault;
  readonly probes: "ran" | "unavailable" | "not-run";
  readonly claims: number;
  readonly holds: number;
  readonly drifted: number;
  readonly unverifiable: number;
  readonly foreign: number;
  readonly safeToResume: boolean;
  readonly workstreams: BriefSection;
  readonly workstreamsFault?: SourceFault;
  readonly workstreamCount: number;
  readonly lines: number;
  readonly linesNotShown: number;
  readonly chars: number;
  readonly neutralized: boolean;
}

export type SourceFault = "failed" | "timeout" | "malformed";

type Sourced<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fault: SourceFault };

const posIntElse = (v: number | undefined, dflt: number): number =>
  Number.isInteger(v) && (v as number) > 0 ? (v as number) : dflt;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

async function sourced<T>(fn: () => Promise<T>, ms: number): Promise<Sourced<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Sourced<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, fault: "timeout" }), ms);
  });
  const run = (async (): Promise<Sourced<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch {
      return { ok: false, fault: "failed" };
    }
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function wellFormed(cp: unknown): SessionCheckpoint | undefined {
  if (typeof cp !== "object" || cp === null) return undefined;
  const o = cp as { id?: unknown; state?: unknown };
  if (typeof o.id !== "string" || o.id.trim() === "") return undefined;
  try {
    const state = parseCheckpointText(encodeCheckpointText(o.state as CheckpointState));
    return state === undefined ? undefined : { id: o.id.trim(), state };
  } catch {
    return undefined;
  }
}

function wellFormedWorkstreams(v: unknown): readonly WorkstreamLine[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WorkstreamLine[] = [];
  for (const w of v) {
    if (typeof w !== "object" || w === null) return undefined;
    const r = w as { slug?: unknown; members?: unknown; status?: unknown };
    if (typeof r.slug !== "string" || r.slug.trim() === "") return undefined;
    const members = Number.isInteger(r.members) && (r.members as number) >= 0 ? (r.members as number) : -1;
    out.push({ slug: r.slug.trim(), members, ...(typeof r.status === "string" ? { status: r.status } : {}) });
  }
  return out;
}

export class SessionStartBrief {
  private readonly maxChars: number;
  private readonly sourceTimeoutMs: number;

  constructor(private readonly opts: SessionStartBriefOptions) {
    this.maxChars = posIntElse(opts.maxChars, DEFAULT_BRIEF_MAX_CHARS);
    this.sourceTimeoutMs = posIntElse(opts.sourceTimeoutMs, DEFAULT_BRIEF_SOURCE_TIMEOUT_MS);
  }

  async handle(payload: unknown): Promise<HostHookReply<"SessionStart"> | undefined> {
    const event = parseSessionStartEvent(payload);
    if (event === undefined) return undefined;
    const base: SessionBriefRecord = {
      eventName: "SessionStart", source: event.source, outcome: "off",
      checkpoint: "not-configured", probes: "not-run",
      claims: 0, holds: 0, drifted: 0, unverifiable: 0, foreign: 0, safeToResume: false,
      workstreams: "not-configured", workstreamCount: 0,
      lines: 0, linesNotShown: 0, chars: 0, neutralized: false,
    };
    const observe = (r: SessionBriefRecord): void => {
      try { this.opts.onBrief?.(r); } catch { }
    };
    try {
      const admit = this.opts.admitSession;
      if (typeof admit !== "function") { observe({ ...base, reason: "no-session-binding" }); return undefined; }
      let admitted = false;
      try { admitted = admit(event) === true; } catch { admitted = false; }
      if (!admitted) { observe({ ...base, reason: "foreign-session" }); return undefined; }
      const served = this.opts.sources;
      if (served !== undefined && !served.includes(event.source)) { observe({ ...base, reason: "source-not-served" }); return undefined; }
      if (this.opts.checkpoint === undefined && this.opts.workstreams === undefined) {
        observe({ ...base, reason: "nothing-configured" });
        return undefined;
      }

      const ms = this.sourceTimeoutMs;
      const [cpRaw, wsRaw] = await Promise.all([
        this.opts.checkpoint === undefined ? undefined : sourced(this.opts.checkpoint, ms),
        this.opts.workstreams === undefined ? undefined : sourced(this.opts.workstreams, ms),
      ]);

      let record: SessionBriefRecord = { ...base };
      let checkpoint: SessionCheckpoint | undefined;
      let report: ResumeReport | undefined;
      if (cpRaw !== undefined) {
        if (!cpRaw.ok) {
          record = { ...record, checkpoint: "unavailable", checkpointFault: cpRaw.fault };
        } else if (cpRaw.value === undefined) {
          record = { ...record, checkpoint: "none" };
        } else {
          checkpoint = wellFormed(cpRaw.value);
          if (checkpoint === undefined) {
            record = { ...record, checkpoint: "unavailable", checkpointFault: "malformed" };
          } else {
            let probes: Readonly<Record<string, Probe>> = {};
            let probesState: SessionBriefRecord["probes"] = "not-run";
            if (this.opts.probes !== undefined) {
              const pr = await sourced(this.opts.probes, ms);
              const ok = pr.ok && typeof pr.value === "object" && pr.value !== null && !Array.isArray(pr.value);
              probes = ok ? pr.value : {};
              probesState = ok ? "ran" : "unavailable";
            }
            try {
              report = verifyResume(checkpoint.state.claims, probes, {
                ...(this.opts.here !== undefined ? { here: this.opts.here } : {}),
                ...(this.opts.matches !== undefined ? { matches: this.opts.matches } : {}),
              });
            } catch {
              report = undefined;
            }
            record = report === undefined
              ? { ...record, checkpoint: "unavailable", checkpointFault: "failed", probes: probesState }
              : {
                  ...record, checkpoint: "shown", probes: probesState,
                  claims: report.claims.length, holds: report.holds, drifted: report.drifted,
                  unverifiable: report.unverifiable, foreign: report.foreign, safeToResume: report.safeToResume,
                };
            if (report === undefined) checkpoint = undefined;
          }
        }
      }
      let workstreams: readonly WorkstreamLine[] | undefined;
      if (wsRaw !== undefined) {
        if (!wsRaw.ok) {
          record = { ...record, workstreams: "unavailable", workstreamsFault: wsRaw.fault };
        } else {
          workstreams = wellFormedWorkstreams(wsRaw.value);
          record = workstreams === undefined
            ? { ...record, workstreams: "unavailable", workstreamsFault: "malformed" }
            : { ...record, workstreams: workstreams.length === 0 ? "none" : "shown", workstreamCount: workstreams.length };
        }
      }

      const lines = this.lines(checkpoint, report, workstreams);
      for (let k = lines.length; k >= 0; k--) {
        const notShown = lines.length - k;
        const shown = lines.slice(0, k);
        if (notShown > 0) shown.push(`… ${notShown} more line(s) not shown (brief limit ${this.maxChars} chars)`);
        if (shown.length === 0) shown.push("nothing could be assembled");
        const ctx = buildInjectionContext([{ cellId: BRIEF_BLOCK_ID, plaintext: shown.join("\n"), epoch: 0, tier: "brief" }]);
        if (ctx.prompt === "") continue;
        const text = `${this.audit(event.source, record, notShown, ctx.neutralized)}\n${ctx.prompt}`;
        if (text.length > this.maxChars) continue;
        observe({ ...record, outcome: "fired", lines: lines.length, linesNotShown: notShown, chars: text.length, neutralized: ctx.neutralized });
        return hostReply("SessionStart", text);
      }
      observe({ ...record, outcome: "silent", reason: "too-small", lines: lines.length, linesNotShown: lines.length });
      return undefined;
    } catch {
      observe({ ...base, outcome: "error", reason: "fault" });
      return undefined;
    }
  }

  private lines(
    checkpoint: SessionCheckpoint | undefined,
    report: ResumeReport | undefined,
    workstreams: readonly WorkstreamLine[] | undefined,
  ): string[] {
    const out: string[] = [];
    if (checkpoint !== undefined && report !== undefined) {
      out.push(clip(`checkpoint ${checkpoint.id} — ${report.verdict}`, LINE_CHARS));
      for (const c of report.claims) if (c.verdict === "drifted") out.push(clip(c.note, LINE_CHARS));
      for (const c of report.claims) if (c.verdict === "unverifiable") out.push(clip(c.note, LINE_CHARS));
      if (checkpoint.state.note !== undefined && checkpoint.state.note.trim() !== "") {
        out.push(clip(`where it stopped: ${checkpoint.state.note.trim()}`, NOTE_CHARS));
      }
      for (const c of report.claims) if (c.verdict === "foreign") out.push(clip(c.note, LINE_CHARS));
      const held = report.claims.filter((c) => c.verdict === "holds").map((c) => c.claim.id);
      if (held.length > 0) out.push(clip(`holds (${held.length}): ${held.join(", ")}`, LINE_CHARS));
    }
    if (workstreams !== undefined && workstreams.length > 0) {
      out.push(`workstreams (${workstreams.length}), as the source reported them:`);
      for (const w of workstreams) {
        const members = w.members >= 0 ? `${w.members} member(s)` : "members unknown";
        out.push(`  ${clip(w.slug, SLUG_CHARS)} — ${members}${w.status !== undefined ? `, ${clip(w.status, SLUG_CHARS)}` : ""}`);
      }
    }
    return out;
  }

  private audit(source: SessionStartSource, r: SessionBriefRecord, notShown: number, neutralized: boolean): string {
    const parts: string[] = [];
    if (r.checkpoint === "shown") {
      const head = r.safeToResume ? "RESUME SAFE" : r.drifted > 0 ? "DRIFTED" : "NOT CLEARED";
      parts.push(
        `checkpoint ${head} — ${r.holds} hold, ${r.drifted} drifted, ${r.unverifiable} unverifiable, ${r.foreign} foreign` +
          (r.probes === "unavailable" ? " (probes UNAVAILABLE)" : r.probes === "not-run" ? " (no probes)" : ""),
      );
    } else if (r.checkpoint === "none") {
      parts.push("no checkpoint");
    } else if (r.checkpoint === "unavailable") {
      parts.push(`checkpoint UNAVAILABLE (${r.checkpointFault ?? "failed"})`);
    }
    if (r.workstreams === "shown" || r.workstreams === "none") parts.push(`${r.workstreamCount} workstream(s)`);
    else if (r.workstreams === "unavailable") parts.push(`workstreams UNAVAILABLE (${r.workstreamsFault ?? "failed"})`);
    return (
      `⇱ SHM session brief (${source}): ${parts.join("; ")}` +
      (notShown > 0 ? ` ⚠ ${notShown} line(s) not shown` : "") +
      (neutralized ? " ⚠ a line tried to forge a delimiter" : "")
    );
  }
}

export interface HookHandler {
  handle(payload: unknown): Promise<HostHookReply<string> | undefined>;
}

export function routeHostHooks(routes: { readonly adapter?: HookHandler; readonly sessionStart?: HookHandler }): HookHandler {
  return {
    async handle(payload: unknown): Promise<HostHookReply<string> | undefined> {
      const name = typeof payload === "object" && payload !== null && !Array.isArray(payload)
        && Object.prototype.hasOwnProperty.call(payload, "hook_event_name")
        ? (payload as Record<string, unknown>)["hook_event_name"]
        : undefined;
      const route = name === "SessionStart" ? routes.sessionStart : routes.adapter;
      if (route === undefined) return undefined;
      try {
        return await route.handle(payload);
      } catch {
        return undefined;
      }
    },
  };
}

export function checkpointFromLedger(store: SaihmDerivedStore, ledger: MintedLedger, thread: string): () => Promise<SessionCheckpoint | undefined> {
  return async () => {
    const rec = await latestCheckpoint(ledger, thread);
    if (rec === undefined) return undefined;
    const state = await readCheckpoint(store, rec.cellId);
    if (state === undefined) throw new Error("the newest checkpoint could not be read");
    return { id: rec.cellId, state };
  };
}

export function workstreamsOf(
  session: { threads(): ReadonlyMap<string, number>; thread(slug: string): { readonly status?: string | undefined } },
  opts: { readonly status?: "open" | "any" } = {},
): () => Promise<readonly WorkstreamLine[]> {
  return async () => {
    const rows = [...session.threads().entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([slug, members]) => {
        const status = session.thread(slug).status;
        return { slug, members, ...(status !== undefined ? { status } : {}) };
      });
    return (opts.status ?? "open") === "open" ? rows.filter((r) => r.status === "open") : rows;
  };
}
