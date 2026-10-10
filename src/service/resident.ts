import type { MemorySession } from "../session/memory_session.js";
import { SessionClosedError } from "../retrieval/session_closed.js";
import type { WarmBuildStats } from "../store/warm_index.js";

export interface ResidentConfig {
  readonly open: () => Promise<MemorySession>;
  readonly freshness?: () => string | number;
  readonly build?: string;
  readonly retire?: (old: MemorySession) => Promise<void>;
  readonly clock?: () => number;
}

export interface ResidentHealth {
  readonly ok: true;
  readonly build: string;
  readonly startedAt: string;
  readonly rebuilds: number;
  readonly lastBuiltAt?: string;
  readonly freshness?: string | number;
  readonly degraded: boolean;
  readonly retiring: number;
  readonly lastError?: string;
  readonly inFlight: boolean;
  readonly warm?: WarmBuildStats;
}

export class ResidentSession {
  private live: MemorySession | undefined;
  private builtToken: string | number | undefined;
  private failedToken: string | number | undefined;
  private inflight: Promise<void> | undefined;
  private rebuilds = 0;
  private lastBuiltAt: number | undefined;
  private lastError: string | undefined;
  private retireErrors = 0;
  private readonly leases = new Map<MemorySession, number>();
  private readonly draining = new Map<MemorySession, () => void>();
  private readonly retirements = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  private closed = false;
  private readonly clock: () => number;
  private readonly startedAtMs: number;

  constructor(private readonly cfg: ResidentConfig) {
    this.clock = cfg.clock ?? Date.now;
    this.startedAtMs = this.clock();
  }

  async start(): Promise<void> {
    if (this.closing !== undefined) throw new SessionClosedError("ResidentSession.start");
    if (this.live !== undefined) return;
    await this.rebuild();
    if (this.live === undefined) throw new Error(`ResidentSession.start: first open failed — ${this.lastError ?? "unknown error"}`);
  }

  current(): MemorySession {
    if (this.closed) throw new SessionClosedError("ResidentSession");
    if (this.live === undefined) throw new Error("ResidentSession: not started");
    return this.live;
  }

  async ensureFresh(): Promise<MemorySession> {
    const live = this.current();
    const f = this.cfg.freshness;
    if (f === undefined || this.closing !== undefined) return live;
    let token: string | number;
    try {
      token = f();
    } catch (e) {
      this.lastError = `freshness: ${(e as Error).message}`;
      return live;
    }
    if (token === this.builtToken || token === this.failedToken) return live;
    if (this.inflight !== undefined) return live;
    await this.rebuild();
    return this.current();
  }

  async use<T>(fn: (session: MemorySession) => Promise<T>): Promise<T> {
    if (this.closing !== undefined) throw new SessionClosedError("ResidentSession.use");
    await this.ensureFresh();
    if (this.closing !== undefined) throw new SessionClosedError("ResidentSession.use");
    const session = this.current();
    this.leases.set(session, (this.leases.get(session) ?? 0) + 1);
    try {
      return await fn(session);
    } finally {
      const left = (this.leases.get(session) ?? 1) - 1;
      if (left > 0) {
        this.leases.set(session, left);
      } else {
        this.leases.delete(session);
        const release = this.draining.get(session);
        if (release !== undefined) {
          this.draining.delete(session);
          release();
        }
      }
    }
  }

  async refresh(): Promise<MemorySession> {
    if (this.closing !== undefined) throw new SessionClosedError("ResidentSession.refresh");
    await this.rebuild();
    return this.current();
  }

  health(): ResidentHealth {
    const iso = (ms: number) => new Date(ms).toISOString();
    return {
      ok: true,
      build: this.cfg.build ?? "unknown",
      startedAt: iso(this.startedAtMs),
      rebuilds: this.rebuilds,
      ...(this.lastBuiltAt !== undefined ? { lastBuiltAt: iso(this.lastBuiltAt) } : {}),
      ...(this.builtToken !== undefined ? { freshness: this.builtToken } : {}),
      degraded: this.lastError !== undefined,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      inFlight: this.inflight !== undefined,
      retiring: this.draining.size,
      ...(this.live !== undefined ? { warm: this.live.buildStats } : {}),
    };
  }

  get retireFailures(): number {
    return this.retireErrors;
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closing = (async () => {
      if (this.inflight !== undefined) await this.inflight;
      for (const [session, release] of [...this.draining]) {
        this.draining.delete(session);
        release();
      }
      await Promise.allSettled([...this.retirements]);
      const s = this.live;
      this.live = undefined;
      this.closed = true;
      if (s !== undefined) await s.close();
    })();
    return this.closing;
  }

  private rebuild(): Promise<void> {
    if (this.inflight !== undefined) return this.inflight;
    if (this.closing !== undefined) return Promise.resolve();
    this.inflight = (async () => {
      let token: string | number | undefined;
      try {
        token = this.cfg.freshness?.();
      } catch (e) {
        token = undefined;
        this.lastError = `freshness: ${(e as Error).message}`;
      }
      try {
        const next = await this.cfg.open();
        const old = this.live;
        this.live = next;
        this.builtToken = token;
        this.failedToken = undefined;
        this.lastBuiltAt = this.clock();
        this.lastError = undefined;
        if (old !== undefined) {
          this.rebuilds += 1;
          if (this.leases.has(old)) {
            const retirement = new Promise<void>((release) => this.draining.set(old, release)).then(() => this.retire(old));
            this.retirements.add(retirement);
            void retirement.finally(() => this.retirements.delete(retirement));
          } else {
            await this.retire(old);
          }
        }
      } catch (e) {
        this.lastError = (e as Error).message;
        this.failedToken = token;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private async retire(old: MemorySession): Promise<void> {
    try {
      await (this.cfg.retire ?? ((s: MemorySession) => s.close()))(old);
    } catch {
      this.retireErrors += 1;
    }
  }
}
