"use client";

import { useSyncExternalStore } from "react";
import { getController, initialGatewayState, type GatewayState } from "./controller";
import { createStore } from "./store";

const SERVER_STATE = initialGatewayState();
const serverStore = createStore(SERVER_STATE);

/** Subscribe to one slice of gateway state. Selectors must return a stable reference (a field, not a new object). */
export function useGateway<S>(selector: (state: GatewayState) => S): S {
  const store = typeof window === "undefined" ? serverStore : getController().store;
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(SERVER_STATE),
  );
}

export { getController };
