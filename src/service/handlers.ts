import type { ResidentSession, ResidentHealth } from "./resident.js";
import type { InjectionBudget, InjectionResult } from "../inject/proactive_injector.js";
import { deriveActionCue, type PendingAction } from "../inject/action_cue.js";
import type { Scope, ScopeSpec } from "../retrieval/scope.js";
import type { WorkstreamAccount } from "../session/memory_session.js";
import { DEFAULT_ANSWER_CONFIG } from "../answer/answer_layer.js";
import { LatencyRecorder, SERVICE_TIERS, evaluateServiceLevel, evaluateTierLevel, type ServiceLevel, type ServiceLevelVerdict, type TierLevelVerdict } from "./service_level.js";
import type { Tier } from "../tiers/membership.js";

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface ServiceOptions {
  readonly guidanceScope?: Scope;
  readonly injectBudget?: InjectionBudget;
  readonly preactBudget?: InjectionBudget;
  readonly nowEpoch?: () => number;
  readonly serviceLevels?: Readonly<Record<string, ServiceLevel>>;
  readonly latencyCapacity?: number;
  readonly tierLevels?: Readonly<Partial<Record<Tier, ServiceLevel>>>;
  readonly tierLatency?: LatencyRecorder;
}

export type ServiceHealth = ResidentHealth & { readonly serviceLevels?: readonly ServiceLevelVerdict[]; readonly tierLevels?: readonly TierLevelVerdict[] };

export interface RecallRequest {
  readonly q: string;
  readonly k?: number;
  readonly asOfEpoch?: number;
}

export interface RecallHit {
  readonly cellId: string;
  readonly rank: number;
  readonly derived?: true;
  readonly supersededBy?: string;
  readonly retiredBy?: string;
}

export interface RecallResponse {
  readonly q: string;
  readonly k: number;
  readonly ms: number;
  readonly hits: readonly RecallHit[];
  readonly detailed: boolean;
}

export interface PreactRequest {
  readonly name: string;
  readonly input: unknown;
}

export interface PreactResponse {
  readonly cue: string;
  readonly result: InjectionResult;
  readonly rendered: string;
}

export interface ThreadsResponse {
  readonly threads: readonly { readonly slug: string; readonly members: number; readonly status: string | null }[];
  readonly scope?: string;
}

export function renderInjectionText(r: InjectionResult): string {
  if (r.injected.length === 0) return "";
  const lines = r.injected.map((m) => `[${m.cellId}] ${m.text.replace(/\s+/g, " ").trim()}`);
  return lines.join("\n");
}

const nonEmpty = (s: unknown, what: string): string => {
  if (typeof s !== "string" || s.trim() === "") throw new ServiceError(400, `missing ${what}`);
  return s.trim();
};

const SPEC_DIMENSIONS = ["threads", "kinds", "namespaces", "cellIds"] as const;

export function parseScopeSpec(raw: unknown): ScopeSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ServiceError(400, "spec must be an object");
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "name" && !(SPEC_DIMENSIONS as readonly string[]).includes(key)) {
      throw new ServiceError(400, `spec: unknown key \`${key}\` — a dimension that is not read would leave the scope wider than written`);
    }
  }
  if (o["name"] !== undefined && typeof o["name"] !== "string") throw new ServiceError(400, "spec.name must be a string");
  const out: Record<string, unknown> = {};
  if (typeof o["name"] === "string") out["name"] = o["name"];
  for (const dim of SPEC_DIMENSIONS) {
    const v = o[dim];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim() !== "")) {
      throw new ServiceError(400, `spec.${dim} must be a list of non-empty strings`);
    }
    out[dim] = [...(v as string[])];
  }
  if (!SPEC_DIMENSIONS.some((dim) => dim in out)) {
    throw new ServiceError(400, "spec names no dimension (threads, kinds, namespaces, cellIds) — send no spec at all for an unscoped read");
  }
  return out as ScopeSpec;
}

export class ServiceHandlers {
  readonly latency: LatencyRecorder;

  constructor(
    private readonly resident: ResidentSession,
    private readonly opts: ServiceOptions = {},
  ) {
    this.latency = new LatencyRecorder(opts.latencyCapacity ?? 512);
    if (opts.tierLevels !== undefined) {
      const unknown = Object.keys(opts.tierLevels).filter((t) => !(SERVICE_TIERS as readonly string[]).includes(t));
      if (unknown.length > 0) throw new Error(`ServiceHandlers: tierLevels names unknown tier ${unknown.map((t) => JSON.stringify(t)).join(", ")} (the tiers are ${SERVICE_TIERS.join(", ")})`);
      if (opts.tierLatency === undefined) throw new Error("ServiceHandlers: tierLevels declared without tierLatency — pass the recorder the sessions were opened with");
    }
  }

  health(): ServiceHealth {
    const base = this.resident.health();
    const levels = this.opts.serviceLevels;
    const tierLevels = this.opts.tierLevels;
    const tierLatency = this.opts.tierLatency;
    if (levels === undefined && tierLevels === undefined) return base;
    const routeVerdicts =
      levels === undefined
        ? undefined
        : Object.keys(levels)
            .sort()
            .map((route) => evaluateServiceLevel(route, levels[route]!, this.latency.stats(route)));
    const tierVerdicts =
      tierLevels === undefined || tierLatency === undefined
        ? undefined
        : SERVICE_TIERS.filter((t) => tierLevels[t] !== undefined).map((t) => evaluateTierLevel(t, tierLevels[t]!, tierLatency.stats(t)));
    return { ...base, ...(routeVerdicts !== undefined ? { serviceLevels: routeVerdicts } : {}), ...(tierVerdicts !== undefined ? { tierLevels: tierVerdicts } : {}) };
  }

  private async timed<T>(route: string, body: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await body();
    } finally {
      this.latency.record(route, performance.now() - t0);
    }
  }

  async recall(req: RecallRequest): Promise<RecallResponse> {
    return this.timed("recall", () => this.recallBody(req));
  }

  private async recallBody(req: RecallRequest): Promise<RecallResponse> {
    const q = nonEmpty(req.q, "q");
    const k = Number.isFinite(req.k) && (req.k as number) >= 1 ? Math.floor(req.k as number) : DEFAULT_ANSWER_CONFIG.topK;
    return this.resident.use(async (session) => {
      const t0 = Date.now();
      const selOpts = { maxK: k, ...(req.asOfEpoch !== undefined ? { asOfEpoch: req.asOfEpoch } : {}) };
      const rr = session.answerRetriever;
      if (typeof rr.selectDetailed === "function") {
        const hits = await rr.selectDetailed(q, selOpts);
        return {
          q,
          k,
          ms: Date.now() - t0,
          detailed: true,
          hits: hits.map((h, i) => ({
            cellId: h.cellId,
            rank: i + 1,
            ...(h.derived === true ? { derived: true as const } : {}),
            ...(h.supersededBy !== undefined ? { supersededBy: h.supersededBy } : {}),
            ...(h.retiredBy !== undefined ? { retiredBy: h.retiredBy } : {}),
          })),
        };
      }
      const ids = await rr.select(q, selOpts);
      return { q, k, ms: Date.now() - t0, detailed: false, hits: ids.map((cellId, i) => ({ cellId, rank: i + 1 })) };
    });
  }

  async inject(req: { readonly taskContext: string; readonly budget?: InjectionBudget }): Promise<InjectionResult> {
    return this.timed("inject", async () => {
      const task = nonEmpty(req.taskContext, "taskContext");
      const budget = req.budget ?? this.opts.injectBudget;
      return this.resident.use((session) => session.proactiveInjector(budget !== undefined ? { budget } : {}).assemble(task));
    });
  }

  async preact(req: PreactRequest): Promise<PreactResponse | undefined> {
    return this.timed("preact", async () => {
      const cue = deriveActionCue(req as PendingAction);
      if (cue === "") return undefined;
      const budget = this.opts.preactBudget;
      const result = await this.resident.use((session) =>
        session.proactiveInjector(budget !== undefined ? { budget } : {}).assemble(cue, undefined, undefined, this.opts.guidanceScope),
      );
      if (result.injected.length === 0) return undefined;
      return { cue, result, rendered: renderInjectionText(result) };
    });
  }

  async threads(req: { readonly spec?: ScopeSpec } = {}): Promise<ThreadsResponse> {
    return this.timed("threads", async () => {
      const spec = req.spec === undefined ? undefined : parseScopeSpec(req.spec);
      return this.resident.use(async (session) => {
        const under = spec === undefined ? {} : { scope: session.scope(spec) };
        const rows = [...session.threads(under).entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([slug, members]) => ({ slug, members, status: session.thread(slug, under).status ?? null }));
        return under.scope === undefined ? { threads: rows } : { threads: rows, scope: under.scope.name };
      });
    });
  }

  async thread(req: { readonly slug: string; readonly spec?: ScopeSpec }): Promise<WorkstreamAccount> {
    return this.timed("thread", async () => {
      const slug = nonEmpty(req.slug, "slug");
      const spec = req.spec === undefined ? undefined : parseScopeSpec(req.spec);
      const nowEpoch = this.opts.nowEpoch !== undefined ? this.opts.nowEpoch() : Math.floor(Date.now() / 3_600_000);
      return this.resident.use(async (session) => session.thread(slug, spec === undefined ? { nowEpoch } : { nowEpoch, scope: session.scope(spec) }));
    });
  }

  async census(spec: ScopeSpec): Promise<{ readonly scope: string; readonly admitted: number; readonly excluded: number; readonly total: number }> {
    return this.timed("census", async () => {
      const checked = parseScopeSpec(spec);
      return this.resident.use(async (session) => {
        const scope = session.scope(checked);
        return { scope: scope.name, ...session.census(scope) };
      });
    });
  }
}
