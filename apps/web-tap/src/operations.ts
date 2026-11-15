import { createRequestId } from "../../../src/shared/lib/webRequestId.ts";
import type { JsonObject, JsonValue, Operation } from "./protocol";
export type OperationTransport = {
  createOperation: (device: string, kind: string, payload: JsonObject, key: string, signal?: AbortSignal) => Promise<{ operation: Operation }>;
  operation: (id: string, signal?: AbortSignal) => Promise<{ operation: Operation }>;
};
/** Register before POST; the deadline also covers stalled HTTP and ignores late completion. */
export function createOperationRunner(transport: OperationTransport) {
  type Pending = {
    device: string; kind: string; controller: AbortController; timer?: ReturnType<typeof setTimeout>;
    deadlineTimer?: ReturnType<typeof setTimeout>;
    resolve: (value: JsonValue) => void; reject: (error: Error) => void;
  };
  const pending = new Map<string, Pending>();
  const settle = (key: string, error: Error | null, result: JsonValue = null) => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    clearTimeout(entry.timer);
    clearTimeout(entry.deadlineTimer);
    entry.controller.abort();
    if (error) entry.reject(error); else entry.resolve(result);
  };
  const publish = (operation: Operation) => {
    const entry = pending.get(operation.idempotencyKey);
    if (!entry || entry.device !== operation.deviceId || entry.kind !== operation.kind) return;
    if (operation.status === "succeeded") settle(operation.idempotencyKey, null, operation.result);
    else if (["failed", "rejected", "timed_out", "canceled"].includes(operation.status))
      settle(operation.idempotencyKey, new Error(operation.error?.code ?? operation.status));
  };
  return {
    run: (device: string, kind: string, payload: JsonObject): Promise<JsonValue> => new Promise((resolve, reject) => {
      const key = createRequestId();
      const entry: Pending = { device, kind, controller: new AbortController(), resolve, reject };
      pending.set(key, entry);
      const deadline = Date.now() + 60_000;
      // HTTP may never return to poll(); expiry must release the caller independently.
      entry.deadlineTimer = setTimeout(() => settle(key, new Error("operation_timed_out")), 60_000);
      const poll = async (id: string) => {
        if (!pending.has(key)) return;
        if (Date.now() > deadline) { settle(key, new Error("operation_timed_out")); return; }
        try {
          const { operation } = await transport.operation(id, entry.controller.signal);
          publish(operation);
          if (pending.has(key)) entry.timer = setTimeout(() => void poll(id), 1_000);
        } catch (error) { if (pending.has(key)) settle(key, error instanceof Error ? error : new Error("request_failed")); }
      };
      transport.createOperation(device, kind, payload, key, entry.controller.signal).then(({ operation }) => {
        publish(operation);
        if (pending.has(key)) entry.timer = setTimeout(() => void poll(operation.id), 500);
      }, (error: unknown) => {
        if (pending.has(key)) settle(key, error instanceof Error ? error : new Error("request_failed"));
      });
    }),
    publish,
    cancel: () => {
      for (const key of pending.keys()) settle(key, new DOMException("scope changed", "AbortError"));
    },
  };
}
