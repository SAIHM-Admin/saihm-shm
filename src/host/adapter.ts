import { buildInjectionContext } from "../answer/context.js";
import type { RecalledBody } from "../saihm_client/types.js";
import { deriveActionCue, type ActionCueOptions } from "../inject/action_cue.js";
import { selectNovel, type InjectionCandidate, type InjectionHistory } from "../inject/novelty.js";
import type { InjectionBudget, InjectionResult } from "../inject/proactive_injector.js";
import { injectionWindowId } from "../inject/window.js";
import type { Scope } from "../retrieval/scope.js";
import { TranscriptCompactionCounter, type CompactCountOf } from "./compaction.js";
import type { SessionAdmission } from "./sessions.js";
import { parseHostEvent, type HostEventName } from "./event.js";
import { hostReply, type HostHookReply } from "./reply.js";

export const DEFAULT_HOST_TURN_ITEMS = 2;
export const DEFAULT_HOST_ACTION_ITEMS = 2;
export const DEFAULT_HOST_OVERFETCH = 15;
export const DEFAULT_HOST_WINDOWS = 4;

const RENDERABLE_ID = /^[^<>=\s]+$/;

export type HostChannel = "turn" | "action";

export interface HostHookAdapterOptions {
  readonly admitSession: SessionAdmission;
  readonly assemble: (cue: string, budget: InjectionBudget, scope: Scope | undefined) => Promise<InjectionResult>;
  readonly turn?: { readonly maxItems?: number; readonly scope?: Scope; readonly enabled?: boolean };
  readonly action?: { readonly maxItems?: number; readonly scope?: Scope; readonly enabled?: boolean; readonly cue?: ActionCueOptions };
  readonly overfetch?: number;
  readonly windows?: number;
  readonly compactCountOf?: CompactCountOf;
  readonly onTurn?: (record: HostTurnRecord) => void;
}

export type HostTurnOutcome = "fired" | "silent" | "off" | "error";

export interface HostRankedMemory {
  readonly cellId: string;
  readonly rank: number;
  readonly epoch: number;
  readonly partial: boolean;
}

export interface HostTurnRecord {
  readonly channel: HostChannel;
  readonly eventName: HostEventName;
  readonly outcome: HostTurnOutcome;
  readonly reason?: "no-session-binding" | "foreign-session" | "empty-cue" | "disabled" | "no-scope" | "none-cleared" | "all-shown" | "fence-empty" | "fault";
  readonly cue: string;
  readonly scope?: string;
  readonly cleared: number;
  readonly ranked: readonly HostRankedMemory[];
  readonly novel: number;
  readonly shown: number;
  readonly suppressed: number;
  readonly unrenderable: number;
  readonly belowFloor: number;
  readonly floor?: number;
  readonly windowKnown: boolean;
  readonly shownIds: readonly string[];
  readonly neutralized: boolean;
  readonly elapsedMs: number;
}

const posIntElse = (v: number | undefined, dflt: number): number =>
  Number.isInteger(v) && (v as number) > 0 ? (v as number) : dflt;

export class HostHookAdapter {
  private readonly windows = new Map<string, InjectionHistory>();
  private readonly maxWindows: number;
  private readonly overfetch: number;
  private readonly compactCountOf: CompactCountOf;

  constructor(private readonly opts: HostHookAdapterOptions) {
    this.maxWindows = posIntElse(opts.windows, DEFAULT_HOST_WINDOWS);
    this.overfetch = posIntElse(opts.overfetch, DEFAULT_HOST_OVERFETCH);
    if (opts.compactCountOf !== undefined) {
      this.compactCountOf = opts.compactCountOf;
    } else {
      const counter = new TranscriptCompactionCounter();
      this.compactCountOf = (p, s) => counter.count(p, s);
    }
  }

  async handle(payload: unknown): Promise<HostHookReply | undefined> {
    const t0 = performance.now();
    const event = parseHostEvent(payload);
    if (event === undefined) return undefined;
    const channel: HostChannel = event.kind === "prompt" ? "turn" : "action";
    const base = {
      channel,
      eventName: event.eventName,
      cue: "",
      cleared: 0, ranked: [] as readonly HostRankedMemory[], novel: 0, shown: 0, suppressed: 0, unrenderable: 0, belowFloor: 0,
      windowKnown: false, shownIds: [] as readonly string[], neutralized: false,
    };
    const observe = (r: Omit<HostTurnRecord, "elapsedMs">): void => {
      try { this.opts.onTurn?.({ ...r, elapsedMs: Math.round(performance.now() - t0) }); } catch { }
    };
    try {
      const admit = this.opts.admitSession;
      if (typeof admit !== "function") { observe({ ...base, outcome: "off", reason: "no-session-binding" }); return undefined; }
      let admitted = false;
      try { admitted = admit(event) === true; } catch { admitted = false; }
      if (!admitted) { observe({ ...base, outcome: "off", reason: "foreign-session" }); return undefined; }
      const cfg = channel === "turn" ? this.opts.turn : this.opts.action;
      if (cfg?.enabled === false) { observe({ ...base, outcome: "off", reason: "disabled" }); return undefined; }
      const scope = cfg?.scope;
      if (channel === "action" && scope === undefined) { observe({ ...base, outcome: "off", reason: "no-scope" }); return undefined; }
      const cue = event.kind === "prompt"
        ? event.prompt
        : deriveActionCue({ name: event.toolName, input: event.toolInput }, this.opts.action?.cue);
      const scoped = { ...base, cue, ...(scope !== undefined ? { scope: scope.name } : {}) };
      if (cue.trim() === "") { observe({ ...scoped, outcome: "silent", reason: "empty-cue" }); return undefined; }

      const raw = await this.opts.assemble(cue, { maxItems: this.overfetch }, scope);
      const renderable = raw.injected.filter((m) => RENDERABLE_ID.test(m.cellId));
      const counts = {
        ...scoped,
        cleared: renderable.length,
        ranked: renderable.map((m): HostRankedMemory => ({ cellId: m.cellId, rank: m.rank, epoch: m.epoch, partial: m.partial })),
        unrenderable: raw.injected.length - renderable.length,
        belowFloor: raw.dropped.filter((d) => d.reason === "below-floor").length,
        ...(raw.relevanceFloor !== undefined ? { floor: raw.relevanceFloor } : {}),
      };
      if (renderable.length === 0) { observe({ ...counts, outcome: "silent", reason: "none-cleared" }); return undefined; }

      const windowId = injectionWindowId({
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
        ...((): { compactCount?: number } => {
          const n = this.compactCountOf(event.transcriptPath, event.sessionId);
          return n !== undefined ? { compactCount: n } : {};
        })(),
      });
      const history = windowId === undefined ? undefined : this.windows.get(windowId);
      const candidates: InjectionCandidate[] = renderable.map((m) => ({ cellId: m.cellId, version: m.epoch }));
      const decision = selectNovel(candidates, history);
      const cap = posIntElse(cfg?.maxItems, channel === "turn" ? DEFAULT_HOST_TURN_ITEMS : DEFAULT_HOST_ACTION_ITEMS);
      const taken = decision.novel.slice(0, cap);
      const funnel = { ...counts, novel: decision.novel.length, suppressed: decision.suppressed.length, windowKnown: windowId !== undefined };
      if (taken.length === 0) { observe({ ...funnel, outcome: "silent", reason: "all-shown" }); return undefined; }

      const byId = new Map(renderable.map((m) => [m.cellId, m]));
      const bodies: RecalledBody[] = taken.flatMap((c) => {
        const m = byId.get(c.cellId);
        return m === undefined ? [] : [{ cellId: m.cellId, plaintext: m.text, epoch: m.epoch, tier: m.tier, partial: m.partial }];
      });
      const ctx = buildInjectionContext(bodies);
      if (ctx.prompt === "") { observe({ ...funnel, outcome: "silent", reason: "fence-empty" }); return undefined; }

      if (windowId !== undefined) {
        const recorded = selectNovel(taken, history);
        if (recorded.next !== undefined) this.remember(windowId, recorded.next);
      }
      const shownIds = taken.map((c) => c.cellId);
      const audit =
        (channel === "action"
          ? `⇱ SHM standing guidance before this action: ${taken.length}${scope !== undefined ? ` [${scope.name}]` : ""}`
          : `⇱ SHM surfaced ${taken.length} unasked`) +
        ` (${renderable.length} cleared the relevance floor ${raw.relevanceFloor ?? "off"},` +
        ` ${decision.suppressed.length} already in context${windowId === undefined ? ", window UNKNOWN" : ""})` +
        `${ctx.neutralized ? " ⚠ a body tried to forge a delimiter" : ""}` +
        `${raw.injected.length > renderable.length ? ` ⚠ ${raw.injected.length - renderable.length} dropped for an unrenderable id` : ""}`;
      observe({ ...funnel, outcome: "fired", shown: taken.length, shownIds, neutralized: ctx.neutralized });
      return hostReply(event.eventName, `${audit}\n${ctx.prompt}`);
    } catch {
      observe({ ...base, outcome: "error", reason: "fault" });
      return undefined;
    }
  }

  private remember(windowId: string, history: InjectionHistory): void {
    this.windows.delete(windowId);
    this.windows.set(windowId, history);
    while (this.windows.size > this.maxWindows) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}
