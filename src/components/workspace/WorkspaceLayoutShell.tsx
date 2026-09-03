import type { ReactNode } from "react";
import { WorkspaceBackground } from "./WorkspaceBackground";

interface WorkspaceLayoutShellProps {
  children: ReactNode;
}

export function WorkspaceLayoutShell({ children }: WorkspaceLayoutShellProps) {
  return (
    <div className="ui-workspace-layout-shell relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <WorkspaceBackground>{children}</WorkspaceBackground>
    </div>
  );
}
