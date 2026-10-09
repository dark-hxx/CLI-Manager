import type { TerminalSession } from "../../../shared/types/index";

/** View tabs may supply a working directory, but never become a terminal title. */
export function resolveNewTerminalContext(session: TerminalSession | null | undefined) {
  switch (session?.kind) {
    case "subagent-transcript":
      return { cwd: undefined, title: "Terminal" };
    case "file-editor":
      return { cwd: session.fileEditor?.projectPath, title: "Terminal" };
    case "worktree-conflict":
      return { cwd: session.cwd, title: "Terminal" };
    default:
      return { cwd: session?.cwd, title: session?.title ?? "Terminal" };
  }
}
