import { Fragment, type ReactNode } from "react";
import type { WorkspanTabBarPosition } from "../../lib/workspaceLayout";

interface WorkspanTerminalLayoutProps {
  position: WorkspanTabBarPosition;
  tabBar: ReactNode;
  children: ReactNode;
}

export function WorkspanTerminalLayout({ position, tabBar, children }: WorkspanTerminalLayoutProps) {
  const topToBottom = [
    <Fragment key="workspan-tabbar">{tabBar}</Fragment>,
    <Fragment key="terminal-body">{children}</Fragment>,
  ];
  const bottomToTop = [
    <Fragment key="terminal-body">{children}</Fragment>,
    <Fragment key="workspan-tabbar">{tabBar}</Fragment>,
  ];

  return (
    <div
      className="ui-workspan-terminal-body"
      data-workspan-tabbar-position={position}
    >
      {position === "top" ? topToBottom : bottomToTop}
    </div>
  );
}
