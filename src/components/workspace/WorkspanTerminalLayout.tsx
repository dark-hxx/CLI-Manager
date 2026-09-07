import { Fragment, type ReactNode } from "react";
import type { WorkspanTabBarPosition } from "../../lib/workspaceLayout";

interface WorkspanTerminalLayoutProps {
  position: WorkspanTabBarPosition;
  tabBar: ReactNode;
  tabBarVisible: boolean;
  children: ReactNode;
}

export function WorkspanTerminalLayout({ position, tabBar, tabBarVisible, children }: WorkspanTerminalLayoutProps) {
  const tabBarSlot = tabBar ? (
    <div
      className="ui-workspan-tabbar-slot"
      data-visible={tabBarVisible ? "true" : "false"}
      style={{ display: tabBarVisible ? "contents" : "none" }}
    >
      {tabBar}
    </div>
  ) : null;
  const topToBottom = [
    <Fragment key="workspan-tabbar">{tabBarSlot}</Fragment>,
    <Fragment key="terminal-body">{children}</Fragment>,
  ];
  const bottomToTop = [
    <Fragment key="terminal-body">{children}</Fragment>,
    <Fragment key="workspan-tabbar">{tabBarSlot}</Fragment>,
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
