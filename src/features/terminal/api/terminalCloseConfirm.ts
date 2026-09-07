import { useSettingsStore } from "../../../shared/preferences/settingsStore";

export const TERMINAL_TAB_CLOSE_REQUEST_EVENT = "cli-manager:terminal-tab-close-request";

export interface TerminalTabCloseRequestDetail {
  sessionIds?: string[];
}

export function shouldConfirmTerminalTabClose(sessionCount = 1): boolean {
  if (sessionCount <= 0) return false;
  return useSettingsStore.getState().confirmBeforeClosingTerminalTab;
}
