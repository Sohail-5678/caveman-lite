/**
 * Per-provider CLOSED -> OPEN -> HALF_OPEN state machine with a TTFT SLA.
 *
 * CLOSED   every request allowed; outcomes feed a rolling window. Trips on N consecutive failures
 *          or on a rolling error rate above the threshold (once the window holds minSamples).
 * OPEN     requests rejected until cooldownMs has elapsed since openedAt.
 * HALF_OPEN exactly one probe request; success closes the breaker, failure (or a slow TTFT) re-opens it.
 */

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface BreakerConfig {
  /** Consecutive failures that trip the breaker. Default 3. */
  failureThreshold: number;
  /** Rolling error rate that trips the breaker (strictly greater). Default 0.2. */
  errorRateThreshold: number;
  /** Minimum samples in the window before the error-rate rule applies. Default 5. */
  minSamples: number;
  /** Rolling window length. Default 20. */
  windowSize: number;
  /** A success slower than this counts as a "slow" failure. Default 1500. */
  ttftSlaMs: number;
  /** Time spent OPEN before a HALF_OPEN probe is allowed. Default 30000. */
  cooldownMs: number;
}

export interface BreakerTransition {
  from: BreakerState;
  to: BreakerState;
  at: number;
  reason: string;
}

export type BreakerSample = "ok" | "fail" | "slow";

export interface BreakerSnapshot {
  name: string;
  state: BreakerState;
  consecutiveFailures: number;
  errorRate: number;
  window: BreakerSample[];
  openedAt: number | null;
  cooldownRemainingMs: number;
  totalTrips: number;
  lastTransition: BreakerTransition | null;
  probeInFlight: boolean;
}

const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 3,
  errorRateThreshold: 0.2,
  minSamples: 5,
  windowSize: 20,
  ttftSlaMs: 1500,
  cooldownMs: 30000,
};

/** 1820 -> "1,820" (locale-independent). */
function thousands(n: number): string {
  const sign = n < 0 ? "-" : "";
  return sign + Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 0.25 -> "25%", 0.2667 -> "26.7%". */
function pct(rate: number): string {
  const p = rate * 100;
  const rounded = Math.round(p);
  return Math.abs(p - rounded) < 1e-9 ? `${rounded}%` : `${(Math.round(p * 10) / 10).toFixed(1)}%`;
}

type Listener = (transition: BreakerTransition, snapshot: BreakerSnapshot) => void;

export class CircuitBreaker {
  readonly name: string;
  readonly config: BreakerConfig;

  private readonly clock: () => number;
  private current: BreakerState = "CLOSED";
  private samples: BreakerSample[] = [];
  private consecutive = 0;
  private openedAt: number | null = null;
  private trips = 0;
  private probe = false;
  private last: BreakerTransition | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(name: string, config?: Partial<BreakerConfig>, clock?: () => number) {
    this.name = name;
    const merged: BreakerConfig = { ...DEFAULT_CONFIG };
    for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof BreakerConfig>) {
      const value = config?.[key];
      if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
    }
    merged.failureThreshold = Math.max(1, Math.floor(merged.failureThreshold));
    merged.windowSize = Math.max(1, Math.floor(merged.windowSize));
    merged.minSamples = Math.max(1, Math.floor(merged.minSamples));
    this.config = Object.freeze(merged);
    this.clock = clock ?? (() => Date.now());
  }

  /** Pure read — never transitions. */
  get state(): BreakerState {
    return this.current;
  }

  /**
   * CLOSED -> true. OPEN -> false until cooldown elapses, then transitions to HALF_OPEN,
   * marks a probe in flight and returns true. HALF_OPEN -> true only if no probe is in flight (and claims it).
   */
  canRequest(): boolean {
    switch (this.current) {
      case "CLOSED":
        return true;
      case "OPEN": {
        const now = this.clock();
        if (this.openedAt !== null && now - this.openedAt < this.config.cooldownMs) return false;
        this.probe = true;
        this.transition("HALF_OPEN", `cooldown ${thousands(this.config.cooldownMs)}ms elapsed · sending one probe`, now);
        return true;
      }
      case "HALF_OPEN":
        if (this.probe) return false;
        this.probe = true;
        return true;
    }
  }

  /** ttftMs > SLA is recorded as "slow" (a failure). HALF_OPEN + ok -> CLOSED (counters reset); HALF_OPEN + slow -> OPEN. */
  recordSuccess(ttftMs: number): void {
    const slow = Number.isFinite(ttftMs) && ttftMs > this.config.ttftSlaMs;
    const detail = `TTFT ${thousands(ttftMs)}ms > ${thousands(this.config.ttftSlaMs)}ms SLA`;
    if (this.current === "OPEN") return; // late result of a request issued before the trip
    if (this.current === "HALF_OPEN") {
      this.probe = false;
      if (slow) {
        this.open(`probe too slow: ${detail}`);
      } else {
        this.samples = [];
        this.consecutive = 0;
        this.openedAt = null;
        this.transition("CLOSED", `probe succeeded (TTFT ${thousands(ttftMs)}ms)`);
      }
      return;
    }
    if (slow) {
      this.push("slow");
      this.consecutive++;
      this.evaluate(detail);
    } else {
      this.push("ok");
      this.consecutive = 0;
    }
  }

  /** HALF_OPEN -> OPEN. CLOSED trips on consecutive >= threshold, or errorRate > threshold with >= minSamples. */
  recordFailure(reason?: string): void {
    if (this.current === "OPEN") return;
    if (this.current === "HALF_OPEN") {
      this.probe = false;
      this.open(`probe failed${reason ? ` (${reason})` : ""}`);
      return;
    }
    this.push("fail");
    this.consecutive++;
    this.evaluate(reason);
  }

  forceOpen(reason: string): void {
    this.probe = false;
    if (this.current === "OPEN") {
      this.openedAt = this.clock(); // restart the cooldown
      return;
    }
    this.open(reason || "forced open");
  }

  /** Back to a fresh CLOSED breaker (counters, window and trip count cleared); listeners are kept. */
  reset(): void {
    const wasClosed = this.current === "CLOSED";
    this.samples = [];
    this.consecutive = 0;
    this.openedAt = null;
    this.trips = 0;
    this.probe = false;
    if (wasClosed) {
      this.last = null;
    } else {
      this.transition("CLOSED", "manual reset");
    }
  }

  snapshot(): BreakerSnapshot {
    const now = this.clock();
    return {
      name: this.name,
      state: this.current,
      consecutiveFailures: this.consecutive,
      errorRate: this.errorRate(),
      window: [...this.samples],
      openedAt: this.openedAt,
      cooldownRemainingMs:
        this.current === "OPEN" && this.openedAt !== null ? Math.max(0, this.openedAt + this.config.cooldownMs - now) : 0,
      totalTrips: this.trips,
      lastTransition: this.last ? { ...this.last } : null,
      probeInFlight: this.probe,
    };
  }

  onTransition(listener: (transition: BreakerTransition, snapshot: BreakerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------------------------

  private errorRate(): number {
    if (this.samples.length === 0) return 0;
    let bad = 0;
    for (const s of this.samples) if (s !== "ok") bad++;
    return bad / this.samples.length;
  }

  private push(sample: BreakerSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.config.windowSize) this.samples.splice(0, this.samples.length - this.config.windowSize);
  }

  /** CLOSED-state trip rules, evaluated after every failure-like sample. */
  private evaluate(detail?: string): void {
    const { failureThreshold, errorRateThreshold, minSamples } = this.config;
    if (this.consecutive >= failureThreshold) {
      this.open(`${this.consecutive} consecutive failures${detail ? ` (${detail})` : ""}`);
      return;
    }
    const rate = this.errorRate();
    if (this.samples.length >= minSamples && rate > errorRateThreshold) {
      this.open(`error rate ${pct(rate)} > ${pct(errorRateThreshold)}`);
    }
  }

  private open(reason: string): void {
    const now = this.clock();
    this.openedAt = now;
    this.trips++;
    this.probe = false;
    this.transition("OPEN", reason, now);
  }

  private transition(to: BreakerState, reason: string, at: number = this.clock()): void {
    const t: BreakerTransition = { from: this.current, to, at, reason };
    this.current = to;
    this.last = t;
    if (this.listeners.size === 0) return;
    const snap = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...t }, snap);
      } catch {
        // a faulty listener must never break the breaker
      }
    }
  }
}
