import { useEffect, useRef, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WorktreeRecoveryGate } from "../lib/worktreeRecoveryGate";

/** 生命周期只探测一次，不做后台轮询；隐藏后响应不能写入新弹窗。 */
export function useWorktreeRecovery(open: boolean, projectPath: string | undefined, worktreePath: string | undefined) {
  const ref = useRef<WorktreeRecoveryGate | null>(null);
  if (!ref.current) ref.current = new WorktreeRecoveryGate((command, args) => invoke(command, args));
  const gate = ref.current;
  const key = JSON.stringify([projectPath, worktreePath]);
  const snapshot = useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  useEffect(() => {
    if (!open || !projectPath || !worktreePath) return;
    void gate.start(projectPath, key);
    return () => gate.stop();
  }, [gate, open, projectPath, worktreePath, key]);
  return { gate, snapshot, key, blocked: snapshot.key !== key || snapshot.phase !== "ready" };
}
