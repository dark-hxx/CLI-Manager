import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type { TabNotificationState } from "../state";

export interface DaemonTaskMeta {
  sessionId: string;
  cwd?: string | null;
  shell?: string | null;
  environmentType?: string | null;
  sshHostId?: string | null;
  remotePath?: string | null;
  alive: boolean;
  taskStatus?: TabNotificationState | null;
  taskUpdatedAtMs?: number | null;
  createdAtMs: number;
}

export interface DaemonTaskInventory {
  tasks: DaemonTaskMeta[];
  status: "unknown" | "fresh" | "stale";
  error: string | null;
}

let snapshot: DaemonTaskInventory = { tasks: [], status: "unknown", error: null };
let pending: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function publish(value: DaemonTaskInventory) {
  snapshot = value;
  for (const listener of listeners) listener();
}

export function getDaemonTaskInventory(): DaemonTaskInventory { return snapshot; }

export function refreshDaemonTaskInventory(): Promise<void> {
  if (pending) return pending;
  pending = invoke<DaemonTaskMeta[]>("pty_daemon_sessions").then(tasks => {
    publish({ tasks, status: "fresh", error: null });
  }).catch(err => {
    // Unavailability is not evidence that tasks stopped; keep the last successful inventory.
    publish({ ...snapshot, status: snapshot.status === "unknown" ? "unknown" : "stale", error: String(err) });
  }).finally(() => { pending = null; });
  return pending;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshDaemonTaskInventory();
    timer = setInterval(() => void refreshDaemonTaskInventory(), 3000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) { clearInterval(timer); timer = null; }
  };
}

const inactiveSubscribe = () => () => {};
export function useDaemonTaskInventory(active = true): DaemonTaskInventory {
  return useSyncExternalStore(active ? subscribe : inactiveSubscribe, getDaemonTaskInventory, getDaemonTaskInventory);
}
