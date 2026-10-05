import { watch, type FSWatcher } from "node:fs";

export interface IndexWatcherConfig {
  readonly dir: string;
  readonly filename?: string;
  readonly debounceMs?: number;
  readonly pollMs?: number;
  readonly onError?: (err: unknown) => void;
}

export class IndexWatcher {
  private watcher: FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private running = false;
  private rerunWanted = false;
  private closed = false;
  private idle: Promise<void> = Promise.resolve();

  private readonly filename: string;
  private readonly debounceMs: number;
  private readonly onError: (err: unknown) => void;

  constructor(
    private readonly cfg: IndexWatcherConfig,
    private readonly trigger: () => Promise<unknown>,
  ) {
    this.filename = cfg.filename ?? "index.json";
    this.debounceMs = cfg.debounceMs ?? 50;
    this.onError =
      cfg.onError ??
      ((err) => {
        throw err;
      });
  }

  start(): void {
    if (this.closed) throw new Error("IndexWatcher.start() after close()");
    if (this.watcher) return;
    this.watcher = watch(this.cfg.dir, (_event, changed) => {
      if (changed === null || changed === this.filename) this.schedule();
    });
    this.watcher.on("error", (err) => this.onError(err));
    if (this.cfg.pollMs !== undefined) {
      this.pollTimer = setInterval(() => this.runSerialized(), this.cfg.pollMs);
      this.pollTimer.unref();
    }
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  settled(): Promise<void> {
    return this.idle;
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.runSerialized();
    }, this.debounceMs);
  }

  private runSerialized(): void {
    if (this.closed) return;
    if (this.running) {
      this.rerunWanted = true;
      return;
    }
    this.running = true;
    let done!: () => void;
    this.idle = new Promise<void>((r) => (done = r));
    void this.trigger()
      .catch((err) => this.onError(err))
      .finally(() => {
        done();
        this.running = false;
        if (this.rerunWanted && !this.closed) {
          this.rerunWanted = false;
          this.runSerialized();
        }
      });
  }
}
