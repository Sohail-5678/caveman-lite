/**
 * Discrete-event virtual clock. Real async code (await, Promise.all, the singleflight lock) runs unchanged;
 * only `sleep` is virtual, so a 50-request burst with 1.8 s upstream calls resolves in a few milliseconds
 * with exact, deterministic timings.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

interface Timer {
  at: number;
  seq: number;
  resolve: () => void;
}

/** Yield one macrotask so every pending microtask continuation has run. */
function macrotask(): Promise<void> {
  if (typeof MessageChannel !== "undefined") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class VirtualClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, resolve });
    });
  }

  /** Advance time event by event until no timers remain. */
  async drain(maxSteps = 50_000): Promise<void> {
    await macrotask();
    let steps = 0;
    while (this.timers.length > 0 && steps++ < maxSteps) {
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift()!;
      this.t = next.at;
      next.resolve();
      await macrotask();
    }
  }
}
