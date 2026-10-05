import type { IndexEntry, SaihmReadPort } from "../saihm_client/types.js";

export type ErasureListener = (cellId: string) => void | Promise<void>;

export class ErasureBus {
  private readonly listeners = new Set<ErasureListener>();

  subscribe(listener: ErasureListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  async publish(cellIds: readonly string[]): Promise<void> {
    const failures: unknown[] = [];
    for (const cellId of cellIds) {
      const snapshot = [...this.listeners];
      const results = await Promise.allSettled(
        snapshot.map((fn) => (async () => fn(cellId))()),
      );
      for (const r of results) {
        if (r.status === "rejected") failures.push(r.reason);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `erasure fan-out: ${failures.length} listener(s) failed`);
    }
  }
}

export class ErasureDetector {
  private liveBaseline = new Set<string>();
  private primed = false;

  constructor(
    private readonly port: SaihmReadPort,
    private readonly bus: ErasureBus,
  ) {}

  prime(entries: readonly IndexEntry[]): void {
    this.liveBaseline = new Set(entries.filter((e) => !e.forgotten).map((e) => e.cellId));
    this.primed = true;
  }

  async checkOnce(): Promise<string[]> {
    if (!this.primed) throw new Error("ErasureDetector.checkOnce() before prime() — fail-closed");
    const entries = await this.port.readIndex();
    const nowLive = new Set(entries.filter((e) => !e.forgotten).map((e) => e.cellId));
    const erased: string[] = [];
    for (const id of this.liveBaseline) {
      if (!nowLive.has(id)) erased.push(id);
    }
    if (erased.length > 0) await this.bus.publish(erased);
    this.liveBaseline = nowLive;
    return erased;
  }
}
