import type { TerminalSession } from "../../../shared/types/index";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { useTerminalStore } from "../state";
import { useSessionStore } from "./sessionStore";
import { addSessionToPaneTree } from "./terminalPaneTree";
import { createTerminalWorkspan, syncTerminalWorkspanLayout, updateTerminalWorkspan, type TerminalWorkspan } from "./terminalWorkspan";
import { buildWorkspanMirror, persistWorkspanState } from "../lib/terminalStoreLayout";

/** Register a view in the existing pane/workspan model; never allocate a PTY. */
export function openWorkspaceViewSession(session: TerminalSession & { kind: "worktree-conflict" }): void {
  const state = useTerminalStore.getState();
  if (state.sessions.some((item) => item.id === session.id)) {
    state.setActive(session.id);
    return;
  }
  const sessions = [...state.sessions, session];
  const target = !useSettingsStore.getState().workspanEnabled
    ? state.workspans.find((item) => item.id === state.activeWorkspanId) ?? state.workspans[0]
    : undefined;
  const paneId = () => `pane-${crypto.randomUUID()}`;
  let workspans: TerminalWorkspan[];
  let activeWorkspanId: string;
  if (target) {
    const pane = addSessionToPaneTree(target.paneTree, target.activePaneId, session.id, paneId);
    workspans = updateTerminalWorkspan(state.workspans, target.id, (item) =>
      syncTerminalWorkspanLayout(item, pane.tree, pane.activePaneId, session.id));
    activeWorkspanId = target.id;
  } else {
    const workspan = createTerminalWorkspan(`workspan-${crypto.randomUUID()}`, paneId(), session.id);
    workspans = [...state.workspans, workspan];
    activeWorkspanId = workspan.id;
  }
  useTerminalStore.setState({ sessions, ...buildWorkspanMirror(workspans, activeWorkspanId), splits: {} });
  void useSessionStore.getState().saveSessions(sessions).catch(() => {});
  persistWorkspanState(workspans, activeWorkspanId, sessions);
}
