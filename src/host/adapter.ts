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
export const DEFAULT_HOST_MAX_BYTES = 4096;
export const MIN_HOST_HEAD_BYTES = 256;
export const DEFAULT_HOST_ACTION_ITEMS = 2;
export const DEFAULT_HOST_OVERFETCH = 15;
export const DEFAULT_HOST_WINDOWS = 4;

const RENDERABLE_ID = /^[^<>=\s]+$/;

export type HostChannel = "turn" | "action";

export interface HostHookAdapterOptions {
  readonly admitSession: SessionAdmission;
  readonly assemble: (cue: string, budget: InjectionBudget, scope: Scope | undefined) => Promise<InjectionResult>;
  readonly turn?: { readonly maxItems?: number; readonly maxBytes?: number; readonly scope?: Scope; readonly enabled?: boolean };
  readonly action?: { readonly maxItems?: number; readonly maxBytes?: number; readonly scope?: Scope; readonly enabled?: boolean; readonly cue?: ActionCueOptions };
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
  readonly reason?: "no-session-binding" | "foreign-session" | "empty-cue" | "disabled" | "no-scope" | "none-cleared" | "all-shown" | "fence-empty" | "over-budget" | "fault";
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
  readonly injectedBytes: number;
  readonly shownBytes: readonly number[];
  readonly cut: number;
  readonly deferred: number;
  readonly maxBytes: number | null;
  readonly elapsedMs: number;
}

const posIntElse = (v: number | undefined, dflt: number): number =>
  Number.isInteger(v) && (v as number) > 0 ? (v as number) : dflt;

const byteCap = (v: number | undefined): number | null =>
  v === Number.POSITIVE_INFINITY ? null : posIntElse(v, DEFAULT_HOST_MAX_BYTES);

function utf8Head(text: string, n: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= n) return text;
  let end = Math.max(0, n);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

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
      injectedBytes: 0, shownBytes: [] as readonly number[], cut: 0, deferred: 0, maxBytes: null as number | null,
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
      const maxBytes = byteCap(cfg?.maxBytes);
      const render = (list: readonly InjectionCandidate[], head: number | undefined) => {
        let cut = 0;
        const bodies: RecalledBody[] = list.flatMap((c) => {
          const m = byId.get(c.cellId);
          if (m === undefined) return [];
          const whole = Buffer.byteLength(m.text, "utf8");
          let text = m.text;
          if (head !== undefined && whole > head) {
            cut += 1;
            text = `${utf8Head(m.text, head)}\n[… cut by SHM to fit this turn: ${whole} bytes in all; recall cell ${m.cellId} for the whole memory]`;
          }
          return [{ cellId: m.cellId, plaintext: text, epoch: m.epoch, tier: m.tier, partial: m.partial || text !== m.text }];
        });
        const ctx = buildInjectionContext(bodies);
        const audit =
          (channel === "action"
            ? `⇱ SHM standing guidance before this action: ${list.length}${scope !== undefined ? ` [${scope.name}]` : ""}`
            : `⇱ SHM surfaced ${list.length} unasked`) +
          ` (${renderable.length} cleared the relevance floor ${raw.relevanceFloor ?? "off"},` +
          ` ${decision.suppressed.length} already in context${windowId === undefined ? ", window UNKNOWN" : ""})` +
          `${cut > 0 ? ` ✂ ${cut} cut to fit ${maxBytes} bytes` : ""}` +
          `${ctx.neutralized ? " ⚠ a body tried to forge a delimiter" : ""}` +
          `${raw.injected.length > renderable.length ? ` ⚠ ${raw.injected.length - renderable.length} dropped for an unrenderable id` : ""}`;
        const additionalContext = ctx.prompt === "" ? "" : `${audit}\n${ctx.prompt}`;
        return { ctx, additionalContext, bytes: Buffer.byteLength(additionalContext, "utf8"), cut, texts: bodies.map((b) => b.plaintext) };
      };

      let shown = taken;
      let r = render(shown, undefined);
      if (maxBytes !== null) {
        let tries = 0;
        while (r.bytes > maxBytes) {
          const fixed = render(shown, 0).bytes;
          let head = Math.floor((maxBytes - fixed) / shown.length);
          if (head < MIN_HOST_HEAD_BYTES) {
            if (shown.length > 1) { shown = shown.slice(0, -1); r = render(shown, undefined); continue; }
            observe({ ...funnel, outcome: "silent", reason: "over-budget", deferred: taken.length, maxBytes });
            return undefined;
          }
          r = render(shown, head);
          while (r.bytes > maxBytes && tries < 3) {
            tries += 1;
            head -= Math.ceil((r.bytes - maxBytes) / shown.length);
            if (head < MIN_HOST_HEAD_BYTES) break;
            r = render(shown, head);
          }
          if (r.bytes > maxBytes) {
            if (shown.length > 1) { shown = shown.slice(0, -1); r = render(shown, undefined); tries = 0; continue; }
            observe({ ...funnel, outcome: "silent", reason: "over-budget", deferred: taken.length, maxBytes });
            return undefined;
          }
        }
      }
      if (r.ctx.prompt === "") { observe({ ...funnel, outcome: "silent", reason: "fence-empty" }); return undefined; }

      if (windowId !== undefined) {
        const recorded = selectNovel(shown, history);
        if (recorded.next !== undefined) this.remember(windowId, recorded.next);
      }
      const shownIds = shown.map((c) => c.cellId);
      observe({
        ...funnel, outcome: "fired", shown: shown.length, shownIds, neutralized: r.ctx.neutralized,
        injectedBytes: r.bytes,
        shownBytes: r.texts.map((x) => Buffer.byteLength(x, "utf8")),
        cut: r.cut, deferred: taken.length - shown.length, maxBytes,
      });
      return hostReply(event.eventName, r.additionalContext);
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
