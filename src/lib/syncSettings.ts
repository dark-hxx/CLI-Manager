import type { Settings } from "../stores/settingsStore";

// Only portable, non-secret preferences belong in cross-device sync.
// Device paths, API keys, shell profiles and background assets stay local.
export const SYNCABLE_SETTING_KEYS = [
  "language",
  "theme",
  "lightThemePalette",
  "darkThemePalette",
  "fontSize",
  "terminalScrollbackCustomEnabled",
  "terminalScrollbackRows",
  "fontFamily",
  "uiFontFamily",
  "uiFontSize",
  "uiTextColor",
  "statuslineEditorSource",
  "sidebarWidth",
  "historySidebarWidth",
  "collapsedGroupIds",
  "terminalThemeMode",
  "terminalThemeName",
  "sidebarDensity",
  "viewMode",
  "closeBehavior",
  "exitWithRunningTasksBehavior",
  "backgroundIncludeFinishedTasks",
  "keyboardShortcuts",
  "terminalNewlineShortcut",
  "unsplitBehavior",
  "terminalToolbarVisibility",
  "sidebarToolbarVisibility",
  "terminalToolbarOrder",
  "terminalSidePanelMerged",
  "terminalSidePanelSingleOpen",
  "terminalSidePanelSkin",
  "terminalPanelWidths",
  "terminalStatsCardVisibility",
  "terminalStatsCardOrder",
  "systemResourceCardVisibility",
  "systemResourceCardOrder",
  "shellRuntimeMonitoringEnabled",
  "ccusageAnalyticsEnabled",
  "terminalSessionRestoreEnabled",
  "projectWorktreeConfigEnabled",
  "terminalSettingsSectionsExpanded",
  "terminalInputSuggestionsEnabled",
  "terminalInputSuggestionUseBuiltinPrompt",
  "terminalInputSuggestionCustomPrompt",
  "hookPopupNotificationsEnabled",
  "hookPopupAutoCloseEnabled",
  "hookPopupAutoCloseSeconds",
  "hookSubagentSplitViewEnabled",
  "systemNotificationsEnabled",
  "suppressSystemNotificationsWhenFocused",
  "systemNotificationEvents",
  "hookSettingsSectionsExpanded",
  "confirmBeforeClosingTerminalTab",
  "terminalTabHoverInfoEnabled",
  "gitGroupBy",
  "batchLaunchGroupInPane",
  "batchLaunchPaneDirection",
  "projectScopedTerminalViewEnabled",
  "workspanEnabled",
] as const satisfies readonly (keyof Settings)[];

export type SyncableSettingKey = (typeof SYNCABLE_SETTING_KEYS)[number];
export type SyncableSettings = Partial<Pick<Settings, SyncableSettingKey>>;

export function pickSyncableSettings(source: Record<string, unknown>): SyncableSettings {
  const result: Record<string, unknown> = {};
  for (const key of SYNCABLE_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = source[key];
    }
  }
  return result as SyncableSettings;
}
