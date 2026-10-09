import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project, WorktreeRecord } from "../../../shared/types/index";
import { ConflictQueue } from "../lib/conflictQueue";
import { conflictErrorText } from "../lib/conflictProtocol";
import type { ConflictProbe } from "../lib/conflictProtocol";

/** Cheap, foreground-only probe. StrictMode/identity changes share a serial IPC lane. */
export function useWorktreeConflictProbe(open: boolean, project: Project | null, worktree: WorktreeRecord | null) {
  const key = JSON.stringify([project?.path, worktree?.path, worktree?.branch, worktree?.base_branch]);
  const [state, setState] = useState<{ key: string; probe: ConflictProbe | null; error: string | null }>({ key: "", probe: null, error: null });
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const queue = useRef(new ConflictQueue());
  useEffect(() => {
    const epoch = ++generation.current;
    if (!open || !project || !worktree) return;
    const context = { projectPath: project.path, worktreePath: worktree.path, worktreeBranch: worktree.branch, baseBranch: worktree.base_branch };
    setState({ key, probe: null, error: null });
    void queue.current.run(async () => {
      if (epoch !== generation.current) return;
      try {
        const probe = await invoke<ConflictProbe>("git_worktree_probe_conflicts", { context });
        if (epoch === generation.current) setState({ key, probe, error: "error" in probe ? conflictErrorText(probe.error) : null });
      } catch (error) {
        if (epoch === generation.current) setState({ key, probe: null, error: conflictErrorText(error) });
      }
    });
    return () => { generation.current++; };
  }, [open, key, refresh, project?.path, worktree?.path, worktree?.branch, worktree?.base_branch]);
  const current = state.key === key ? state : { key, probe: null, error: null };
  return { ...current, blocked: current.probe?.kind !== "none", refresh: () => setRefresh((value) => value + 1) };
}
