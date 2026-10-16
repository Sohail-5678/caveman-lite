/**
 * Singleflight stampede lock: concurrent callers with the same key share one in-flight Promise.
 *
 * A cold, popular key would otherwise fan out N identical upstream LLM calls (a cache stampede).
 * The first caller becomes the leader and registers its flight synchronously, before any await;
 * every caller that arrives while the flight is pending awaits the same promise.
 */

export type FlightRole = "leader" | "follower";

export interface FlightResult<T> {
  value: T;
  role: FlightRole;
  key: string;
  /** Followers that joined this flight, counted at settlement. */
  followers: number;
}

interface Flight<T> {
  promise: Promise<T>;
  followers: number;
}

export class Singleflight<T> {
  private readonly flights = new Map<string, Flight<T>>();
  private counters = { leaders: 0, followers: 0, upstreamCalls: 0 };

  /**
   * Leader registers synchronously (before any await) then runs fn; followers await the same promise.
   * The key is released in `finally`; a rejection propagates to every waiter.
   */
  run(key: string, fn: () => Promise<T>): Promise<FlightResult<T>> {
    const existing = this.flights.get(key);
    if (existing) {
      existing.followers++;
      this.counters.followers++;
      return existing.promise.then((value) => ({ value, role: "follower", key, followers: existing.followers }));
    }

    // Deferred promise: the flight exists in the map before fn runs at all, so even a synchronous
    // re-entrant call from inside fn joins as a follower instead of starting a second upstream call.
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const flight: Flight<T> = {
      promise: new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
      followers: 0,
    };
    this.flights.set(key, flight);
    this.counters.leaders++;

    const release = () => {
      // Only remove our own flight: reset() may have let a newer flight take this key.
      if (this.flights.get(key) === flight) this.flights.delete(key);
    };

    // An async body runs synchronously up to its first await, so fn() is invoked inside run().
    // Settling schedules the waiters as microtasks and `finally` releases the key in the same tick,
    // so every waiter already observes isInFlight(key) === false.
    void (async () => {
      try {
        this.counters.upstreamCalls++;
        resolve(await fn());
      } catch (error) {
        reject(error);
      } finally {
        release();
      }
    })();

    return flight.promise.then((value) => ({ value, role: "leader", key, followers: flight.followers }));
  }

  isInFlight(key: string): boolean {
    return this.flights.has(key);
  }

  /** Followers currently waiting on the in-flight call for `key` (0 when idle). */
  followers(key: string): number {
    return this.flights.get(key)?.followers ?? 0;
  }

  inFlightKeys(): string[] {
    return [...this.flights.keys()];
  }

  get stats(): { leaders: number; followers: number; upstreamCalls: number } {
    return { ...this.counters };
  }

  /** Zeroes the counters and forgets in-flight keys (pending callers still receive their result). */
  reset(): void {
    this.counters = { leaders: 0, followers: 0, upstreamCalls: 0 };
    this.flights.clear();
  }
}
