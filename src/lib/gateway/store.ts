import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(update: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(update) {
      const patch = typeof update === "function" ? update(state) : update;
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribe to one slice. The selector must return a stable reference (a field, not a fresh object). */
export function useStoreSelector<T, S>(store: Store<T>, selector: (state: T) => S, serverValue?: S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => (serverValue !== undefined ? serverValue : selector(store.get())),
  );
}
