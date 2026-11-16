import type { WebDeviceStatus } from "./webDevice";

let issuedRevision = 0;
let acceptedRevision = 0;
let latest: WebDeviceStatus | null = null;
const listeners = new Set<(status: WebDeviceStatus) => void>();

export function beginWebDeviceStatusRequest(): number {
  return ++issuedRevision;
}

/** Share the existing bridge probes; settings do not create another poller. */
export function publishWebDeviceStatus(
  status: WebDeviceStatus,
  revision = beginWebDeviceStatusRequest(),
): void {
  if (revision < acceptedRevision) return;
  acceptedRevision = revision;
  latest = status;
  for (const listener of listeners) listener(status);
}

export function subscribeWebDeviceStatus(listener: (status: WebDeviceStatus) => void): () => void {
  listeners.add(listener);
  if (latest) listener(latest);
  return () => { listeners.delete(listener); };
}
