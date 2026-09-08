import { useSidebarController } from "../hooks/useSidebarController";
import { SidebarView } from "./SidebarView";
import type { SidebarProps } from "../lib/sidebarModel";

export function Sidebar(props: SidebarProps) {
  return <SidebarView {...useSidebarController(props)} />;
}
