import type { NativeProviderFailoverState } from "./nativeProviderTypes";

type FailoverListener = (state: NativeProviderFailoverState) => void;

const latestByAppType = new Map<NativeProviderFailoverState["appType"], NativeProviderFailoverState>();
const listeners = new Set<FailoverListener>();

/** Share the last authoritative failover snapshot between independently mounted settings/sidebar hooks. */
export function publishProviderFailoverState(state: NativeProviderFailoverState): void {
  latestByAppType.set(state.appType, state);
  listeners.forEach((listener) => listener(state));
}

/** New subscribers immediately receive the latest successful snapshot for every app type. */
export function subscribeProviderFailoverState(listener: FailoverListener): () => void {
  latestByAppType.forEach((state) => listener(state));
  listeners.add(listener);
  return () => listeners.delete(listener);
}
