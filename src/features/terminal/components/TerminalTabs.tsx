import { useTerminalTabsController } from "../hooks/useTerminalTabsController";
import { TerminalTabsView } from "./TerminalTabsView";
import type { TerminalTabsProps } from "../lib/terminalTabsModel";

export function TerminalTabs(props: TerminalTabsProps = {}) {
  return <TerminalTabsView {...useTerminalTabsController(props)} />;
}
