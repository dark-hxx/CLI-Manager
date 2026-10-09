import { useLayoutEffect, useRef } from "react";
import { useWorktreeConflictStore } from "./worktreeConflictStore";

/** The native tab owns a dock, while the global host preserves the editor/controller. */
export function WorktreeConflictPane({ sessionId }: { sessionId: string }) {
  const dock = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = dock.current;
    if (!node || useWorktreeConflictStore.getState().sessionId !== sessionId) return;
    useWorktreeConflictStore.setState({ mountPoint: node });
    return () => {
      if (useWorktreeConflictStore.getState().mountPoint === node) {
        useWorktreeConflictStore.setState({ mountPoint: null });
      }
    };
  }, [sessionId]);
  return <div ref={dock} className="conflict-tab-slot" data-session-kind="worktree-conflict" />;
}
