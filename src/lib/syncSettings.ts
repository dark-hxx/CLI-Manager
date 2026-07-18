import type { Settings } from "../stores/settingsStore";

export type BackupSettingDomain = "preferences" | "notifications" | "excluded";

// 穷尽分类：Settings 新增字段但未明确分类时，TypeScript 会直接报错。
export const SETTING_BACKUP_POLICY = {
  language: "preferences",
  theme: "preferences",
  lightThemePalette: "preferences",
  darkThemePalette: "preferences",
  fontSize: "preferences",
  terminalScrollbackCustomEnabled: "excluded",
  terminalScrollbackRows: "excluded",
  fontFamily: "preferences",
  uiFontFamily: "preferences",
  uiFontSize: "preferences",
  uiTextColor: "preferences",
  lastSettingsTab: "excluded",
  statuslineEditorSource: "preferences",
  defaultShell: "excluded",
  sidebarWidth: "preferences",
  historySidebarWidth: "preferences",
  collapsedGroupIds: "preferences",
  useExternalTerminal: "excluded",
  debugMode: "excluded",
  terminalThemeMode: "preferences",
  terminalThemeName: "preferences",
  sidebarDensity: "preferences",
  sidebarProjectFilterVisible: "preferences",
  viewMode: "preferences",
  closeBehavior: "preferences",
  exitWithRunningTasksBehavior: "preferences",
  backgroundIncludeFinishedTasks: "preferences",
  keyboardShortcuts: "preferences",
  terminalNewlineShortcut: "preferences",
  unsplitBehavior: "preferences",
  terminalToolbarVisibility: "preferences",
  sidebarToolbarVisibility: "preferences",
  terminalToolbarOrder: "preferences",
  terminalSidePanelMerged: "preferences",
  terminalSidePanelSingleOpen: "preferences",
  terminalSidePanelSkin: "preferences",
  terminalPanelWidths: "preferences",
  terminalStatsCardVisibility: "preferences",
  terminalStatsCardOrder: "preferences",
  systemResourceCardVisibility: "preferences",
  systemResourceCardOrder: "preferences",
  systemResourceMonitoringEnabled: "excluded",
  shellRuntimeMonitoringEnabled: "preferences",
  ccusageAnalyticsEnabled: "preferences",
  ccusageUseWsl: "excluded",
  windowsConptyCompatibilityFixEnabled: "excluded",
  terminalSessionRestoreEnabled: "excluded",
  projectWorktreeConfigEnabled: "preferences",
  symlinkCompatibilityEnabled: "excluded",
  lowMemoryMode: "excluded",
  disableHardwareAcceleration: "excluded",
  linuxGraphicsMode: "excluded",
  terminalBackground: "excluded",
  terminalShellProfiles: "excluded",
  terminalSettingsSectionsExpanded: "preferences",
  terminalInputSuggestionsEnabled: "preferences",
  terminalInputSuggestionProvider: "preferences",
  terminalInputSuggestionLlmEnabled: "preferences",
  terminalInputSuggestionBaseUrl: "preferences",
  terminalInputSuggestionApiKey: "preferences",
  terminalInputSuggestionModel: "preferences",
  terminalInputSuggestionUseBuiltinPrompt: "preferences",
  terminalInputSuggestionCustomPrompt: "preferences",
  terminalInputSuggestionUsage: "excluded",
  terminalInputSuggestionLastTest: "excluded",
  hookPopupNotificationsEnabled: "preferences",
  hookPopupAutoCloseEnabled: "preferences",
  hookPopupAutoCloseSeconds: "preferences",
  hookSubagentSplitViewEnabled: "preferences",
  claudeHookBridgeEnabled: "excluded",
  codexHookBridgeEnabled: "excluded",
  systemNotificationsEnabled: "preferences",
  suppressSystemNotificationsWhenFocused: "preferences",
  systemNotificationEvents: "preferences",
  hookSettingsSectionsExpanded: "preferences",
  thirdPartyHookNotificationsEnabled: "notifications",
  thirdPartyHookTargets: "notifications",
  claudeHookConfigDir: "excluded",
  claudeHookAutoRepairKnownInstalled: "excluded",
  claudeHookAutoRepairNoticeShown: "excluded",
  codexHookConfigDir: "excluded",
  ccSwitchDbPath: "excluded",
  gitGroupBy: "preferences",
  confirmBeforeClosingTerminalTab: "preferences",
  terminalTabHoverInfoEnabled: "preferences",
  fileExplorerIgnoredPaths: "preferences",
  batchLaunchGroupInPane: "preferences",
  batchLaunchPaneDirection: "preferences",
  projectScopedTerminalViewEnabled: "preferences",
  workspanEnabled: "excluded",
  desktopPet: "excluded",
} as const satisfies Record<keyof Settings, BackupSettingDomain>;

function keysForDomain<D extends BackupSettingDomain>(domain: D) {
  return (Object.keys(SETTING_BACKUP_POLICY) as (keyof Settings)[]).filter(
    (key) => SETTING_BACKUP_POLICY[key] === domain,
  );
}

type KeysWithPolicy<D extends BackupSettingDomain> = {
  [K in keyof typeof SETTING_BACKUP_POLICY]: (typeof SETTING_BACKUP_POLICY)[K] extends D ? K : never;
}[keyof typeof SETTING_BACKUP_POLICY];

export const SYNCABLE_SETTING_KEYS = keysForDomain("preferences") as KeysWithPolicy<"preferences">[];
export type SyncableSettingKey = (typeof SYNCABLE_SETTING_KEYS)[number];
export type SyncableSettings = Partial<Pick<Settings, SyncableSettingKey>>;

export function pickSyncableSettings(source: Record<string, unknown>): SyncableSettings {
  const result: Partial<Record<keyof Settings, unknown>> = {};
  for (const key of SYNCABLE_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = source[key];
    }
  }
  return result as SyncableSettings;
}
