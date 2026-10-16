/**
 * Per-key token bucket (default 20 requests / minute / IP).
 *
 * Buckets refill continuously (refillPerMinute, default = capacity) and are created lazily; idle
 * buckets that have refilled to capacity are pruned so the map cannot grow without bound.
 * Levels are kept in "token-milliseconds" (1 token = 60,000 units) so that integer configurations
 * and integer clocks never accumulate floating-point drift.
 */

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  limit: number;
}

interface Bucket {
  /** tokens × 60,000 */
  level: number;
  updatedAt: number;
}

const UNITS_PER_TOKEN = 60_000;
const MAX_BUCKETS = 10_000;

export class TokenBucketLimiter {
  private readonly capacity: number;
  /** Units added per elapsed millisecond (= tokens per minute). */
  private readonly refillPerMinute: number;
  private readonly clock: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options?: { capacity?: number; refillPerMinute?: number; clock?: () => number }) {
    const capacity = options?.capacity ?? 20;
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? capacity : 20;
    const refill = options?.refillPerMinute ?? this.capacity;
    this.refillPerMinute = Number.isFinite(refill) && refill > 0 ? refill : 0;
    this.clock = options?.clock ?? (() => Date.now());
  }

  /**
   * Takes `cost` tokens (default 1) from `key`'s bucket. A denied request consumes nothing;
   * retryAfterMs is the wait until enough tokens have refilled (Infinity if that can never happen).
   */
  take(key: string, cost = 1): RateDecision {
    const now = this.clock();
    const need = (Number.isFinite(cost) && cost > 0 ? cost : 1) * UNITS_PER_TOKEN;
    const bucket = this.refill(key, now);

    if (bucket.level >= need) {
      bucket.level -= need;
      return { allowed: true, remaining: Math.floor(bucket.level / UNITS_PER_TOKEN), retryAfterMs: 0, limit: this.capacity };
    }
    const retryAfterMs =
      need > this.capacity * UNITS_PER_TOKEN || this.refillPerMinute === 0
        ? Infinity
        : Math.ceil((need - bucket.level) / this.refillPerMinute);
    return { allowed: false, remaining: Math.floor(bucket.level / UNITS_PER_TOKEN), retryAfterMs, limit: this.capacity };
  }

  /** Forget one key, or every key when called without arguments. */
  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }

  private refill(key: string, now: number): Bucket {
    const full = this.capacity * UNITS_PER_TOKEN;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= MAX_BUCKETS) this.prune(now);
      bucket = { level: full, updatedAt: now };
      this.buckets.set(key, bucket);
      return bucket;
    }
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.level = Math.min(full, bucket.level + elapsed * this.refillPerMinute);
    bucket.updatedAt = now;
    return bucket;
  }

  /** Drop buckets that would be full by now (indistinguishable from a fresh bucket). */
  private prune(now: number): void {
    const full = this.capacity * UNITS_PER_TOKEN;
    for (const [key, bucket] of this.buckets) {
      if (bucket.level + Math.max(0, now - bucket.updatedAt) * this.refillPerMinute >= full) this.buckets.delete(key);
    }
  }
}
