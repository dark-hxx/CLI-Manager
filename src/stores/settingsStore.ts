import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { resolveAutoTerminalThemeId } from "../lib/terminalThemes";
import { backgroundImageExists } from "../lib/assetUrl";
import { defaultShellForOs, getOsPlatform, isWindowsOnlyShellKey } from "../lib/shell";
import { getCliManagerDataPaths } from "../lib/appPaths";
import { singleFlight } from "../lib/singleFlight";
import {
  DEFAULT_TERMINAL_INPUT_SUGGESTION_USAGE,
  TERMINAL_INPUT_SUGGESTION_AI_MODEL,
  mergeTerminalInputSuggestionUsage,
  type TerminalInputSuggestionAiAttempt,
  type TerminalInputSuggestionModelTestResult,
  type TerminalInputSuggestionProvider,
  type TerminalInputSuggestionUsageStats,
} from "../lib/terminalInputSuggestions";
import {
  migrateTerminalShellProfiles,
  type TerminalShellProfile,
} from "../lib/terminalShellProfiles";
import {
  sanitizeThirdPartyHookTargets,
  type ThirdPartyHookTarget,
} from "../lib/thirdPartyNotifications";
import {
  DESKTOP_PET_SIZE_DEFAULT_PERCENT,
  normalizeDesktopPetSizePercent,
  type DesktopPetSizePercent,
} from "../lib/desktopPetSize";

export {
  DESKTOP_PET_SIZE_DEFAULT_PERCENT,
  DESKTOP_PET_SIZE_MAX_PERCENT,
  DESKTOP_PET_SIZE_MIN_PERCENT,
  DESKTOP_PET_SIZE_STEP_PERCENT,
} from "../lib/desktopPetSize";

export type ThemeMode = "dark" | "light" | "system";
export type LightThemePalette =
  | "warm-paper"
  | "cream-green"
  | "ink-red"
  | "emerald-mist"
  | "saas-analytics-dashboard"
  | "apple-pure"
  | "apple-mist"
  | "apple-warm"
  | "apple-mono";
export type DarkThemePalette =
  | "night-indigo"
  | "forest-night"
  | "graphite-red"
  | "investment-platform"
  | "github-dark"
  | "catppuccin-mocha"
  | "terminal-green"
  | "dracula-purple"
  | "carbon-black";
export type TerminalThemeMode = "system" | "independent";
export type SidebarDensity = "compact" | "comfortable";
export type ViewMode = "standard" | "compact";
export type CloseBehavior = "ask" | "minimize" | "exit";
/** 退出时存在运行中任务的处理方式：询问 / 后台继续 / 丢弃任务并退出。 */
export type ExitWithRunningTasksBehavior = "ask" | "background" | "minimize" | "discard";
export const LINUX_GRAPHICS_MODES = ["auto", "system", "disable-dmabuf", "disable-compositing"] as const;
export type LinuxGraphicsMode = (typeof LINUX_GRAPHICS_MODES)[number];
type LastSettingsTab =
  | "general"
  | "desktop-pet"
  | "developer"
  | "sidebar"
  | "terminal-theme"
  | "shortcuts"
  | "templates"
  | "providers"
  | "model-pricing"
  | "cc-connect"
  | "ssh-hosts"
  | "sync"
  | "history-sources"
  | "hooks"
  | "statusline"
  | "command-suggestions"
  | "about";
export type StatuslineEditorSource = "claude" | "codex";
export type TerminalSidePanelSkin = "terminal" | "classic-terminal" | "warm-paper" | "sunrise" | "linen" | "latte";
export type TerminalStatsCardKey =
  | "session"
  | "tokenUsage"
  | "tokenTrend"
  | "modelContext"
  | "tools"
  | "latestChanges"
  | "todayUsage";
export type SystemResourceCardKey =
  | "system"
  | "cpu"
  | "memory"
  | "network"
  | "disk"
  | "gpu"
  | "processes";
export type TerminalPanelWidthKey = "merged" | "stats" | "git" | "replay" | "files" | "systemResources";
export type TerminalPanelWidthSettings = Record<TerminalPanelWidthKey, number>;
export type TerminalSettingsSectionKey = "behavior" | "shells" | "themes" | "background";
export type TerminalSettingsSectionsExpanded = Record<TerminalSettingsSectionKey, boolean>;
export type HookSettingsSectionKey = "toast" | "notifications" | "claude" | "codex" | "pi";
export type HookSettingsSectionsExpanded = Record<HookSettingsSectionKey, boolean>;
export const UI_FONT_SIZE_MIN = 11;
export const UI_FONT_SIZE_MAX = 18;
export const UI_FONT_SIZE_DEFAULT = 13;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_SCROLLBACK_ROWS_MIN = 1000;
export const TERMINAL_SCROLLBACK_ROWS_MAX = 50000;
export const TERMINAL_SCROLLBACK_ROWS_DEFAULT = 9000;
export const TERMINAL_PANEL_WIDTH_MAX = 500;
export const TERMINAL_PANEL_WIDTH_DEFAULTS: TerminalPanelWidthSettings = {
  merged: 300,
  stats: 203,
  git: 196,
  replay: 300,
  files: 220,
  systemResources: 300,
};
export const TERMINAL_SETTINGS_SECTION_KEYS: readonly TerminalSettingsSectionKey[] = [
  "behavior",
  "shells",
  "themes",
  "background",
];
export const TERMINAL_SETTINGS_SECTIONS_EXPANDED_DEFAULT: TerminalSettingsSectionsExpanded = {
  behavior: true,
  shells: false,
  themes: false,
  background: false,
};
export const HOOK_SETTINGS_SECTION_KEYS: readonly HookSettingsSectionKey[] = [
  "toast",
  "notifications",
  "claude",
  "codex",
  "pi",
];
export const HOOK_SETTINGS_SECTIONS_EXPANDED_DEFAULT: HookSettingsSectionsExpanded = {
  toast: false,
  notifications: false,
  claude: false,
  codex: false,
  pi: false,
};
export type ShortcutAction =
  | "newTerminal"
  | "closeTerminal"
  | "nextTab"
  | "prevTab"
  | "commandPalette"
  | "sessionHistory"
  | "copyAi"
  | "toggleSidebar"
  | "toggleTerminalFullscreen";
export type TabSwitchShortcutModifier = "Alt" | "Ctrl" | "Shift";
export type KeyboardShortcutMap = Record<ShortcutAction, string>;
export type TerminalNewlineShortcut = "Shift+Enter" | "Ctrl+Enter" | "Alt+Enter";
export type UnsplitBehavior = "merge" | "close";
export type FileExplorerIgnoredPaths = Record<string, string[]>;
export type LanguagePreference = "auto" | "zh-CN" | "zh-TW" | "en-US";
export type BatchLaunchPaneDirection = "vertical" | "horizontal";
export type DesktopPetSize = DesktopPetSizePercent;
export const DESKTOP_PET_WORK_BOUNCE_MIN_PX = 0;
export const DESKTOP_PET_WORK_BOUNCE_MAX_PX = 5;

export interface DesktopPetPosition {
  x: number;
  y: number;
}

export interface DesktopPetSettings {
  enabled: boolean;
  petId: string;
  alwaysOnTop: boolean;
  size: DesktopPetSize;
  showActionMenu: boolean;
  openOnHover: boolean;
  workingBounceEnabled: boolean;
  workingBounceDistancePx: number;
  showStatus: boolean;
  showSessionName: boolean;
  autoHideFullscreen: boolean;
  lockPosition: boolean;
  position: DesktopPetPosition | null;
}

export const BUILTIN_DESKTOP_PET_ID = "builtin.cli-cat";

export type HookEventType =
  | "SessionStart"
  | "UserPromptSubmit"
  | "Notification"
  | "Stop"
  | "StopFailure"
  | "PermissionRequest";

const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  "newTerminal",
  "closeTerminal",
  "nextTab",
  "prevTab",
  "commandPalette",
  "sessionHistory",
  "copyAi",
  "toggleSidebar",
  "toggleTerminalFullscreen",
];

export interface TerminalToolbarVisibilitySettings {
  templates: boolean;
  fullscreen: boolean;
  sessionHistory: boolean;
  replay: boolean;
  files: boolean;
  stats: boolean;
  gitChanges: boolean;
  systemResources: boolean;
  backgroundTasks: boolean;
  showText: boolean;
}

export interface SidebarToolbarVisibilitySettings {
  stats: boolean;
  gitChanges: boolean;
}

export type TerminalStatsCardVisibilitySettings = Record<TerminalStatsCardKey, boolean>;
export type TerminalStatsCardOrderSettings = TerminalStatsCardKey[];
export type SystemResourceCardVisibilitySettings = Record<SystemResourceCardKey, boolean>;
export type SystemResourceCardOrderSettings = SystemResourceCardKey[];

export const TERMINAL_STATS_CARD_KEYS: readonly TerminalStatsCardKey[] = [
  "session",
  "tokenUsage",
  "tokenTrend",
  "modelContext",
  "tools",
  "latestChanges",
  "todayUsage",
];

export const SYSTEM_RESOURCE_CARD_KEYS: readonly SystemResourceCardKey[] = [
  "system",
  "cpu",
  "memory",
  "network",
  "disk",
  "gpu",
  "processes",
];

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutMap = {
  newTerminal: "Ctrl+Shift+T",
  closeTerminal: "Ctrl+W",
  nextTab: "Alt+ArrowRight",
  prevTab: "Alt+ArrowLeft",
  commandPalette: "Ctrl+P",
  sessionHistory: "Ctrl+K",
  copyAi: "Alt+P",
  toggleSidebar: "Ctrl+B",
  toggleTerminalFullscreen: "F11",
};

export type TerminalBackgroundFit = "cover" | "contain" | "center" | "tile";
export type TerminalBackgroundPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center-left"
  | "center"
  | "center-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface TerminalBackgroundSettings {
  enabled: boolean;
  imagePath: string | null;
  imageSizeBytes: number | null;
  opacity: number;
  fit: TerminalBackgroundFit;
  position: TerminalBackgroundPosition;
  blur: number;
  overlayDarken: number;
}

const TERMINAL_BACKGROUND_FITS: readonly TerminalBackgroundFit[] = [
  "cover",
  "contain",
  "center",
  "tile",
] as const;

const TERMINAL_BACKGROUND_POSITIONS: readonly TerminalBackgroundPosition[] = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export interface Settings {
  language: LanguagePreference;
  theme: ThemeMode;
  lightThemePalette: LightThemePalette;
  darkThemePalette: DarkThemePalette;
  fontSize: number;
  terminalScrollbackCustomEnabled: boolean;
  terminalScrollbackRows: number;
  fontFamily: string;
  uiFontFamily: string;
  uiFontSize: number;
  uiTextColor: string;
  lastSettingsTab: LastSettingsTab;
  statuslineEditorSource: StatuslineEditorSource;
  defaultShell: string;
  sidebarWidth: number;
  historySidebarWidth: number;
  collapsedGroupIds: string[];
  useExternalTerminal: boolean;
  debugMode: boolean;
  terminalThemeMode: TerminalThemeMode;
  terminalThemeName: string;
  sidebarDensity: SidebarDensity;
  sidebarProjectFilterVisible: boolean;
  viewMode: ViewMode;
  closeBehavior: CloseBehavior;
  exitWithRunningTasksBehavior: ExitWithRunningTasksBehavior;
  /** 退出检测是否把「已完成/失败」的 Claude/Codex 会话也算作可转入后台的任务（默认仅检测运行中）。 */
  backgroundIncludeFinishedTasks: boolean;
  keyboardShortcuts: KeyboardShortcutMap;
  terminalNewlineShortcut: TerminalNewlineShortcut;
  unsplitBehavior: UnsplitBehavior;
  terminalToolbarVisibility: TerminalToolbarVisibilitySettings;
  sidebarToolbarVisibility: SidebarToolbarVisibilitySettings;
  terminalToolbarOrder: string[];
  /** 是否把实时统计与 Git 变更合并为带 Tab 的单一侧边面板；关闭后两者可并排独立显示。 */
  terminalSidePanelMerged: boolean;
  /** 是否限制终端辅助侧边面板同一时间只打开一个。 */
  terminalSidePanelSingleOpen: boolean;
  terminalSidePanelSkin: TerminalSidePanelSkin;
  terminalPanelWidths: TerminalPanelWidthSettings;
  terminalStatsCardVisibility: TerminalStatsCardVisibilitySettings;
  terminalStatsCardOrder: TerminalStatsCardOrderSettings;
  systemResourceCardVisibility: SystemResourceCardVisibilitySettings;
  systemResourceCardOrder: SystemResourceCardOrderSettings;
  systemResourceMonitoringEnabled: boolean;
  shellRuntimeMonitoringEnabled: boolean;
  ccusageAnalyticsEnabled: boolean;
  ccusageUseWsl: boolean;
  windowsConptyCompatibilityFixEnabled: boolean;
  terminalSessionRestoreEnabled: boolean;
  projectWorktreeConfigEnabled: boolean;
  symlinkCompatibilityEnabled: boolean;
  lowMemoryMode: boolean;
  disableHardwareAcceleration: boolean;
  linuxGraphicsMode: LinuxGraphicsMode;
  terminalBackground: TerminalBackgroundSettings;
  terminalShellProfiles: TerminalShellProfile[];
  /** 终端设置页各可折叠区块的展开状态记忆。 */
  terminalSettingsSectionsExpanded: TerminalSettingsSectionsExpanded;
  terminalInputSuggestionsEnabled: boolean;
  terminalInputSuggestionProvider: TerminalInputSuggestionProvider;
  terminalInputSuggestionLlmEnabled: boolean;
  terminalInputSuggestionBaseUrl: string;
  terminalInputSuggestionApiKey: string;
  terminalInputSuggestionModel: string;
  terminalInputSuggestionUseBuiltinPrompt: boolean;
  terminalInputSuggestionCustomPrompt: string;
  terminalInputSuggestionUsage: TerminalInputSuggestionUsageStats;
  terminalInputSuggestionLastTest: TerminalInputSuggestionModelTestResult | null;
  hookPopupNotificationsEnabled: boolean;
  hookPopupAutoCloseEnabled: boolean;
  hookPopupAutoCloseSeconds: number;
  hookSubagentSplitViewEnabled: boolean;
  claudeHookBridgeEnabled: boolean;
  codexHookBridgeEnabled: boolean;
  piHookBridgeEnabled: boolean;
  systemNotificationsEnabled: boolean;
  suppressSystemNotificationsWhenFocused: boolean;
  systemNotificationEvents: Record<HookEventType, boolean>;
  /** Hook 设置页各可折叠区块的展开状态记忆。 */
  hookSettingsSectionsExpanded: HookSettingsSectionsExpanded;
  thirdPartyHookNotificationsEnabled: boolean;
  thirdPartyHookTargets: ThirdPartyHookTarget[];
  remoteHandoffNotificationsEnabled: boolean;
  remoteHandoffCompletionNotificationsEnabled: boolean;
  remoteHandoffPermissionNotificationsEnabled: boolean;
  remoteHandoffProgressNotificationsEnabled: boolean;
  remoteHandoffProgressIntervalMinutes: number;
  claudeHookConfigDir: string | null;
  claudeHookAutoRepairKnownInstalled: boolean;
  claudeHookAutoRepairNoticeShown: boolean;
  codexHookConfigDir: string | null;
  piHookConfigDir: string | null;
  /** cc-switch 数据库路径；null 表示使用默认路径 ~/.cc-switch/cc-switch.db */
  ccSwitchDbPath: string | null;
  /** Git 变更树分组模式：directory（按目录树） / module（按顶层目录模块） */
  gitGroupBy: "directory" | "module";
  confirmBeforeClosingTerminalTab: boolean;
  terminalTabHoverInfoEnabled: boolean;
  fileExplorerIgnoredPaths: FileExplorerIgnoredPaths;
  /** 批量启动分组时，同一分组终端放在同一个 pane 中（多 tab），不同分组创建在不同 pane。默认关闭。 */
  batchLaunchGroupInPane: boolean;
  /** 批量启动分屏方向：vertical（上下分屏） / horizontal（左右分屏）。默认 horizontal。 */
  batchLaunchPaneDirection: BatchLaunchPaneDirection;
  projectScopedTerminalViewEnabled: boolean;
  workspanEnabled: boolean;
  desktopPet: DesktopPetSettings;
}

interface SettingsStore extends Settings {
  resolvedTheme: "dark" | "light";
  loaded: boolean;
  /** Transient flag: set when the saved terminal background image was not found on disk at load. */
  terminalBackgroundMissing: boolean;
  load: () => Promise<void>;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
  recordTerminalInputSuggestionUsage: (event: TerminalInputSuggestionAiAttempt | { accepted: true }) => void;
  setTheme: (mode: ThemeMode) => Promise<void>;
  setTerminalThemeMode: (mode: TerminalThemeMode) => Promise<void>;
  syncSystemTheme: () => void;
  clearTerminalBackgroundMissing: () => void;
}

const DEFAULTS: Settings = {
  language: "auto",
  theme: "system",
  lightThemePalette: "emerald-mist",
  darkThemePalette: "terminal-green",
  fontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalScrollbackCustomEnabled: false,
  terminalScrollbackRows: TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  fontFamily: "Cascadia Code, Consolas, monospace",
  uiFontFamily:
    "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
  uiFontSize: UI_FONT_SIZE_DEFAULT,
  uiTextColor: "",
  lastSettingsTab: "general",
  statuslineEditorSource: "claude",
  defaultShell: "powershell.exe",
  sidebarWidth: 248,
  historySidebarWidth: 276,
  collapsedGroupIds: [],
  useExternalTerminal: false,
  debugMode: false,
  terminalThemeMode: "independent",
  terminalThemeName: "forestNightDark",
  sidebarDensity: "comfortable",
  sidebarProjectFilterVisible: false,
  viewMode: "standard",
  closeBehavior: "ask",
  exitWithRunningTasksBehavior: "ask",
  backgroundIncludeFinishedTasks: false,
  keyboardShortcuts: DEFAULT_KEYBOARD_SHORTCUTS,
  terminalNewlineShortcut: "Shift+Enter",
  unsplitBehavior: "merge",
  terminalToolbarVisibility: {
    templates: true,
    fullscreen: true,
    sessionHistory: true,
    replay: false,
    files: true,
    stats: true,
    gitChanges: true,
    systemResources: false,
    backgroundTasks: true,
    showText: false,
  },
  sidebarToolbarVisibility: {
    stats: true,
    gitChanges: true,
  },
  terminalToolbarOrder: ["new", "templates", "fullscreen", "sessionHistory", "replay", "files", "gitChanges", "stats", "systemResources", "backgroundTasks"],
  terminalSidePanelMerged: true,
  terminalSidePanelSingleOpen: true,
  terminalSidePanelSkin: "terminal",
  terminalPanelWidths: { ...TERMINAL_PANEL_WIDTH_DEFAULTS },
  terminalStatsCardVisibility: {
    session: true,
    tokenUsage: true,
    tokenTrend: true,
    modelContext: true,
    tools: true,
    latestChanges: true,
    todayUsage: true,
  },
  terminalStatsCardOrder: [...TERMINAL_STATS_CARD_KEYS],
  systemResourceCardVisibility: {
    system: true,
    cpu: true,
    memory: true,
    network: true,
    disk: true,
    gpu: true,
    processes: true,
  },
  systemResourceCardOrder: [...SYSTEM_RESOURCE_CARD_KEYS],
  systemResourceMonitoringEnabled: false,
  shellRuntimeMonitoringEnabled: false,
  ccusageAnalyticsEnabled: false,
  ccusageUseWsl: false,
  windowsConptyCompatibilityFixEnabled: false,
  terminalSessionRestoreEnabled: true,
  projectWorktreeConfigEnabled: true,
  symlinkCompatibilityEnabled: false,
  lowMemoryMode: false,
  disableHardwareAcceleration: false,
  linuxGraphicsMode: "auto",
  terminalBackground: {
    enabled: false,
    imagePath: null,
    imageSizeBytes: null,
    opacity: 50,
    fit: "cover",
    position: "center",
    blur: 0,
    overlayDarken: 30,
  },
  terminalShellProfiles: [],
  terminalSettingsSectionsExpanded: { ...TERMINAL_SETTINGS_SECTIONS_EXPANDED_DEFAULT },
  terminalInputSuggestionsEnabled: true,
  terminalInputSuggestionProvider: "local",
  terminalInputSuggestionLlmEnabled: false,
  terminalInputSuggestionBaseUrl: "",
  terminalInputSuggestionApiKey: "",
  terminalInputSuggestionModel: TERMINAL_INPUT_SUGGESTION_AI_MODEL,
  terminalInputSuggestionUseBuiltinPrompt: true,
  terminalInputSuggestionCustomPrompt: "",
  terminalInputSuggestionUsage: { ...DEFAULT_TERMINAL_INPUT_SUGGESTION_USAGE },
  terminalInputSuggestionLastTest: null,
  hookPopupNotificationsEnabled: true,
  hookPopupAutoCloseEnabled: true,
  hookPopupAutoCloseSeconds: 60,
  hookSubagentSplitViewEnabled: true,
  claudeHookBridgeEnabled: true,
  codexHookBridgeEnabled: true,
  piHookBridgeEnabled: true,
  systemNotificationsEnabled: true,
  suppressSystemNotificationsWhenFocused: true,
  systemNotificationEvents: {
    SessionStart: false,
    UserPromptSubmit: false,
    Notification: true,
    Stop: true,
    StopFailure: true,
    PermissionRequest: true,
  },
  hookSettingsSectionsExpanded: { ...HOOK_SETTINGS_SECTIONS_EXPANDED_DEFAULT },
  thirdPartyHookNotificationsEnabled: true,
  thirdPartyHookTargets: [],
  remoteHandoffNotificationsEnabled: true,
  remoteHandoffCompletionNotificationsEnabled: true,
  remoteHandoffPermissionNotificationsEnabled: true,
  remoteHandoffProgressNotificationsEnabled: true,
  remoteHandoffProgressIntervalMinutes: 5,
  claudeHookConfigDir: null,
  claudeHookAutoRepairKnownInstalled: false,
  claudeHookAutoRepairNoticeShown: false,
  codexHookConfigDir: null,
  piHookConfigDir: null,
  ccSwitchDbPath: null,
  gitGroupBy: "directory",
  confirmBeforeClosingTerminalTab: false,
  terminalTabHoverInfoEnabled: true,
  fileExplorerIgnoredPaths: {},
  batchLaunchGroupInPane: false,
  batchLaunchPaneDirection: "horizontal",
  projectScopedTerminalViewEnabled: false,
  workspanEnabled: true,
  desktopPet: {
    enabled: false,
    petId: BUILTIN_DESKTOP_PET_ID,
    alwaysOnTop: true,
    size: DESKTOP_PET_SIZE_DEFAULT_PERCENT,
    showActionMenu: true,
    openOnHover: true,
    workingBounceEnabled: false,
    workingBounceDistancePx: 5,
    showStatus: true,
    showSessionName: false,
    autoHideFullscreen: true,
    lockPosition: false,
    position: null,
  },
};

const LEGACY_LIGHT_PALETTE_MAP: Partial<Record<string, LightThemePalette>> = {
  "luxury-commerce": "saas-analytics-dashboard",
};

const LEGACY_DARK_PALETTE_MAP: Partial<Record<string, DarkThemePalette>> = {
  "crypto-wallet": "investment-platform",
  "nord-night": "terminal-green",
};

const LEGACY_TERMINAL_THEME_MAP: Partial<Record<string, string>> = {
  luxuryCommerceLight: "saasAnalyticsDashboardLight",
  cryptoWalletDark: "investmentPlatformDark",
};

const LAST_SETTINGS_TABS: readonly LastSettingsTab[] = [
  "general",
  "desktop-pet",
  "developer",
  "sidebar",
  "terminal-theme",
  "shortcuts",
  "templates",
  "providers",
  "model-pricing",
  "cc-connect",
  "ssh-hosts",
  "sync",
  "history-sources",
  "hooks",
  "statusline",
  "command-suggestions",
  "about",
];

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(mode: ThemeMode): "dark" | "light" {
  return mode === "system" ? getSystemTheme() : mode;
}

function migrateLightThemePalette(value: unknown): LightThemePalette | undefined {
  if (typeof value !== "string") return undefined;
  return (LEGACY_LIGHT_PALETTE_MAP[value] ?? value) as LightThemePalette;
}

function migrateDarkThemePalette(value: unknown): DarkThemePalette | undefined {
  if (typeof value !== "string") return undefined;
  return (LEGACY_DARK_PALETTE_MAP[value] ?? value) as DarkThemePalette;
}

function migrateTerminalThemeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return LEGACY_TERMINAL_THEME_MAP[value] ?? value;
}

function migrateSystemNotificationEvents(value: unknown): Record<HookEventType, boolean> {
  const defaults = DEFAULTS.systemNotificationEvents;
  if (typeof value !== "object" || value === null) {
    return { ...defaults };
  }
  const raw = value as Record<string, unknown>;
  const events: HookEventType[] = [
    "SessionStart",
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "StopFailure",
    "PermissionRequest",
  ];
  const result: Record<HookEventType, boolean> = { ...defaults };
  for (const event of events) {
    if (typeof raw[event] === "boolean") {
      result[event] = raw[event];
    }
  }
  return result;
}

function migrateLastSettingsTab(value: unknown): LastSettingsTab {
  return typeof value === "string" && LAST_SETTINGS_TABS.includes(value as LastSettingsTab)
    ? (value as LastSettingsTab)
    : DEFAULTS.lastSettingsTab;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function migrateKeyboardShortcuts(value: unknown): KeyboardShortcutMap {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_KEYBOARD_SHORTCUTS };
  }

  const raw = value as Partial<Record<ShortcutAction, unknown>>;
  const next: KeyboardShortcutMap = { ...DEFAULT_KEYBOARD_SHORTCUTS };
  for (const action of SHORTCUT_ACTIONS) {
    const shortcut = raw[action];
    if (typeof shortcut === "string") next[action] = shortcut.trim();
  }
  return next;
}

export function migrateTerminalToolbarVisibility(value: unknown): TerminalToolbarVisibilitySettings {
  const defaults = DEFAULTS.terminalToolbarVisibility;
  if (typeof value !== "object" || value === null) {
    return { ...defaults };
  }
  const raw = value as Record<string, unknown>;

  return {
    templates: typeof raw.templates === "boolean" ? raw.templates : defaults.templates,
    fullscreen: typeof raw.fullscreen === "boolean" ? raw.fullscreen : defaults.fullscreen,
    sessionHistory: typeof raw.sessionHistory === "boolean" ? raw.sessionHistory : defaults.sessionHistory,
    replay: typeof raw.replay === "boolean" ? raw.replay : defaults.replay,
    files: typeof raw.files === "boolean" ? raw.files : defaults.files,
    stats: typeof raw.stats === "boolean" ? raw.stats : defaults.stats,
    gitChanges: typeof raw.gitChanges === "boolean" ? raw.gitChanges : defaults.gitChanges,
    systemResources: typeof raw.systemResources === "boolean" ? raw.systemResources : defaults.systemResources,
    backgroundTasks: typeof raw.backgroundTasks === "boolean" ? raw.backgroundTasks : defaults.backgroundTasks,
    showText: typeof raw.showText === "boolean" ? raw.showText : defaults.showText,
  };
}

export function migrateSidebarToolbarVisibility(value: unknown): SidebarToolbarVisibilitySettings {
  const defaults = DEFAULTS.sidebarToolbarVisibility;
  if (typeof value !== "object" || value === null) {
    return { ...defaults };
  }
  const raw = value as Record<string, unknown>;

  return {
    stats: typeof raw.stats === "boolean" ? raw.stats : defaults.stats,
    gitChanges: typeof raw.gitChanges === "boolean" ? raw.gitChanges : defaults.gitChanges,
  };
}

export function migrateTerminalToolbarOrder(value: unknown): string[] {
  const defaults = DEFAULTS.terminalToolbarOrder;
  if (!Array.isArray(value)) return [...defaults];

  const validKeys = new Set(defaults);
  const filtered = value.filter((k): k is string => typeof k === "string" && validKeys.has(k));
  const missing = defaults.filter((k) => !filtered.includes(k));
  return [...filtered, ...missing];
}

function migrateTerminalSidePanelSkin(value: unknown): TerminalSidePanelSkin {
  return value === "terminal" ||
    value === "classic-terminal" ||
    value === "warm-paper" ||
    value === "sunrise" ||
    value === "linen" ||
    value === "latte"
    ? value
    : DEFAULTS.terminalSidePanelSkin;
}

export function migrateTerminalPanelWidths(value: unknown): TerminalPanelWidthSettings {
  const raw = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    merged: clampNumber(raw.merged, TERMINAL_PANEL_WIDTH_DEFAULTS.merged, TERMINAL_PANEL_WIDTH_MAX, TERMINAL_PANEL_WIDTH_DEFAULTS.merged),
    stats: clampNumber(raw.stats, TERMINAL_PANEL_WIDTH_DEFAULTS.stats, TERMINAL_PANEL_WIDTH_MAX, TERMINAL_PANEL_WIDTH_DEFAULTS.stats),
    git: clampNumber(raw.git, TERMINAL_PANEL_WIDTH_DEFAULTS.git, TERMINAL_PANEL_WIDTH_MAX, TERMINAL_PANEL_WIDTH_DEFAULTS.git),
    replay: clampNumber(raw.replay, TERMINAL_PANEL_WIDTH_DEFAULTS.replay, TERMINAL_PANEL_WIDTH_MAX, TERMINAL_PANEL_WIDTH_DEFAULTS.replay),
    files: clampNumber(raw.files, TERMINAL_PANEL_WIDTH_DEFAULTS.files, TERMINAL_PANEL_WIDTH_MAX, TERMINAL_PANEL_WIDTH_DEFAULTS.files),
    systemResources: clampNumber(raw.systemResources, TERMINAL_PANEL_WIDTH_DEFAULTS.systemResources, TERMINAL_PANEL_WIDTH_MAX, TERMINAL_PANEL_WIDTH_DEFAULTS.systemResources),
  };
}

export function migrateTerminalSettingsSectionsExpanded(value: unknown): TerminalSettingsSectionsExpanded {
  const defaults = TERMINAL_SETTINGS_SECTIONS_EXPANDED_DEFAULT;
  if (typeof value !== "object" || value === null) {
    return { ...defaults };
  }
  const raw = value as Partial<Record<TerminalSettingsSectionKey, unknown>>;
  return TERMINAL_SETTINGS_SECTION_KEYS.reduce<TerminalSettingsSectionsExpanded>((next, key) => {
    next[key] = typeof raw[key] === "boolean" ? raw[key] : defaults[key];
    return next;
  }, { ...defaults });
}

export function migrateHookSettingsSectionsExpanded(value: unknown): HookSettingsSectionsExpanded {
  const defaults = HOOK_SETTINGS_SECTIONS_EXPANDED_DEFAULT;
  if (typeof value !== "object" || value === null) {
    return { ...defaults };
  }
  const raw = value as Partial<Record<HookSettingsSectionKey, unknown>>;
  return HOOK_SETTINGS_SECTION_KEYS.reduce<HookSettingsSectionsExpanded>((next, key) => {
    next[key] = typeof raw[key] === "boolean" ? raw[key] : defaults[key];
    return next;
  }, { ...defaults });
}

export function migrateTerminalStatsCardVisibility(value: unknown): TerminalStatsCardVisibilitySettings {
  const defaults = DEFAULTS.terminalStatsCardVisibility;
  if (typeof value !== "object" || value === null) {
    return { ...defaults };
  }
  const raw = value as Partial<Record<TerminalStatsCardKey, unknown>>;
  return TERMINAL_STATS_CARD_KEYS.reduce<TerminalStatsCardVisibilitySettings>((next, key) => {
    next[key] = typeof raw[key] === "boolean" ? raw[key] : defaults[key];
    return next;
  }, { ...defaults });
}

export function migrateTerminalStatsCardOrder(value: unknown): TerminalStatsCardOrderSettings {
  const defaults = DEFAULTS.terminalStatsCardOrder;
  if (!Array.isArray(value)) return [...defaults];

  const validKeys = new Set<TerminalStatsCardKey>(TERMINAL_STATS_CARD_KEYS);
  const seen = new Set<TerminalStatsCardKey>();
  const ordered: TerminalStatsCardKey[] = [];

  for (const item of value) {
    if (typeof item !== "string") continue;
    const key = item as TerminalStatsCardKey;
    if (!validKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }

  for (const key of defaults) {
    if (!seen.has(key)) ordered.push(key);
  }

  return ordered;
}

export function migrateSystemResourceCardVisibility(value: unknown): SystemResourceCardVisibilitySettings {
  const defaults = DEFAULTS.systemResourceCardVisibility;
  if (typeof value !== "object" || value === null) {
    return { ...defaults };
  }
  const raw = value as Partial<Record<SystemResourceCardKey, unknown>>;
  return SYSTEM_RESOURCE_CARD_KEYS.reduce<SystemResourceCardVisibilitySettings>((next, key) => {
    next[key] = typeof raw[key] === "boolean" ? raw[key] : defaults[key];
    return next;
  }, { ...defaults });
}

export function migrateSystemResourceCardOrder(value: unknown): SystemResourceCardOrderSettings {
  const defaults = DEFAULTS.systemResourceCardOrder;
  if (!Array.isArray(value)) return [...defaults];

  const validKeys = new Set<SystemResourceCardKey>(SYSTEM_RESOURCE_CARD_KEYS);
  const seen = new Set<SystemResourceCardKey>();
  const ordered: SystemResourceCardKey[] = [];

  for (const item of value) {
    if (typeof item !== "string") continue;
    const key = item as SystemResourceCardKey;
    if (!validKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }

  for (const key of defaults) {
    if (!seen.has(key)) ordered.push(key);
  }

  return ordered;
}

function migrateUnsplitBehavior(value: unknown): UnsplitBehavior {
  return value === "close" || value === "merge" ? value : DEFAULTS.unsplitBehavior;
}

function migrateLanguagePreference(value: unknown): LanguagePreference {
  return value === "auto" || value === "zh-CN" || value === "zh-TW" || value === "en-US" ? value : DEFAULTS.language;
}

function migrateFileExplorerIgnoredPaths(value: unknown): FileExplorerIgnoredPaths {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const result: FileExplorerIgnoredPaths = {};
  for (const [projectId, paths] of Object.entries(value as Record<string, unknown>)) {
    if (!projectId || !Array.isArray(paths)) continue;
    const cleanPaths = Array.from(new Set(paths.filter((path): path is string => (
      typeof path === "string"
      && path.length > 0
      && !path.includes("\\")
      && !path.split("/").includes("..")
    ))));
    if (cleanPaths.length > 0) {
      result[projectId] = cleanPaths;
    }
  }
  return result;
}

function migrateTerminalInputSuggestionProvider(value: unknown): TerminalInputSuggestionProvider {
  return value === "local" || value === "ai" ? value : DEFAULTS.terminalInputSuggestionProvider;
}

function migrateTerminalInputSuggestionUsage(value: unknown): TerminalInputSuggestionUsageStats {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_TERMINAL_INPUT_SUGGESTION_USAGE };
  }
  const raw = value as Record<string, unknown>;
  return {
    requestCount: clampNumber(raw.requestCount, 0, Number.MAX_SAFE_INTEGER, 0),
    successCount: clampNumber(raw.successCount, 0, Number.MAX_SAFE_INTEGER, 0),
    failureCount: clampNumber(raw.failureCount, 0, Number.MAX_SAFE_INTEGER, 0),
    fallbackCount: clampNumber(raw.fallbackCount, 0, Number.MAX_SAFE_INTEGER, 0),
    acceptedCount: clampNumber(raw.acceptedCount, 0, Number.MAX_SAFE_INTEGER, 0),
    totalResponseTimeMs: clampNumber(raw.totalResponseTimeMs, 0, Number.MAX_SAFE_INTEGER, 0),
    totalInputTokens: clampNumber(raw.totalInputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
    totalOutputTokens: clampNumber(raw.totalOutputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
    totalTokens: clampNumber(raw.totalTokens, 0, Number.MAX_SAFE_INTEGER, 0),
    lastStatus:
      raw.lastStatus === "operational" ||
      raw.lastStatus === "degraded" ||
      raw.lastStatus === "failed" ||
      raw.lastStatus === "fallback"
        ? raw.lastStatus
        : null,
    lastMessage: typeof raw.lastMessage === "string" ? raw.lastMessage : null,
    lastResponseTimeMs:
      typeof raw.lastResponseTimeMs === "number" && Number.isFinite(raw.lastResponseTimeMs)
        ? Math.max(0, raw.lastResponseTimeMs)
        : null,
    lastUsedAt:
      typeof raw.lastUsedAt === "number" && Number.isFinite(raw.lastUsedAt)
        ? Math.max(0, raw.lastUsedAt)
        : null,
    lastAcceptedAt:
      typeof raw.lastAcceptedAt === "number" && Number.isFinite(raw.lastAcceptedAt)
        ? Math.max(0, raw.lastAcceptedAt)
        : null,
  };
}

function migrateTerminalInputSuggestionLastTest(value: unknown): TerminalInputSuggestionModelTestResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.status !== "operational" && raw.status !== "degraded" && raw.status !== "failed") return null;
  if (typeof raw.success !== "boolean" || typeof raw.message !== "string") return null;
  return {
    status: raw.status,
    success: raw.success,
    message: raw.message,
    responseTimeMs:
      typeof raw.responseTimeMs === "number" && Number.isFinite(raw.responseTimeMs)
        ? Math.max(0, raw.responseTimeMs)
        : undefined,
    httpStatus:
      typeof raw.httpStatus === "number" && Number.isFinite(raw.httpStatus)
        ? Math.max(0, Math.round(raw.httpStatus))
        : undefined,
    testedAt:
      typeof raw.testedAt === "number" && Number.isFinite(raw.testedAt)
        ? Math.max(0, raw.testedAt)
        : Math.floor(Date.now() / 1000),
  };
}

export function migrateTerminalBackground(value: unknown): TerminalBackgroundSettings {
  const defaults = DEFAULTS.terminalBackground;
  if (typeof value !== "object" || value === null) {
    return { ...defaults };
  }
  const raw = value as Record<string, unknown>;

  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled;
  const imagePath =
    typeof raw.imagePath === "string" && raw.imagePath.length > 0
      ? raw.imagePath
      : raw.imagePath === null
      ? null
      : defaults.imagePath;
  const imageSizeBytes =
    typeof raw.imageSizeBytes === "number" && Number.isFinite(raw.imageSizeBytes) && raw.imageSizeBytes >= 0
      ? raw.imageSizeBytes
      : defaults.imageSizeBytes;
  const opacity = clampNumber(raw.opacity, 0, 100, defaults.opacity);
  const blur = clampNumber(raw.blur, 0, 20, defaults.blur);
  const overlayDarken = clampNumber(raw.overlayDarken, 0, 80, defaults.overlayDarken);

  const fit: TerminalBackgroundFit =
    typeof raw.fit === "string" && TERMINAL_BACKGROUND_FITS.includes(raw.fit as TerminalBackgroundFit)
      ? (raw.fit as TerminalBackgroundFit)
      : defaults.fit;

  const position: TerminalBackgroundPosition =
    typeof raw.position === "string" &&
    TERMINAL_BACKGROUND_POSITIONS.includes(raw.position as TerminalBackgroundPosition)
      ? (raw.position as TerminalBackgroundPosition)
      : defaults.position;

  return { enabled, imagePath, imageSizeBytes, opacity, fit, position, blur, overlayDarken };
}

export function migrateDesktopPetSettings(value: unknown): DesktopPetSettings {
  const defaults = DEFAULTS.desktopPet;
  if (!value || typeof value !== "object") {
    return { ...defaults, position: null };
  }
  const raw = value as Record<string, unknown>;
  const rawPosition = raw.position;
  const position = rawPosition && typeof rawPosition === "object"
    ? (() => {
        const candidate = rawPosition as Record<string, unknown>;
        if (
          typeof candidate.x !== "number" ||
          !Number.isFinite(candidate.x) ||
          typeof candidate.y !== "number" ||
          !Number.isFinite(candidate.y)
        ) {
          return null;
        }
        return {
          x: Math.round(clampNumber(candidate.x, -100_000, 100_000, 0)),
          y: Math.round(clampNumber(candidate.y, -100_000, 100_000, 0)),
        };
      })()
    : null;
  const petId = typeof raw.petId === "string" && raw.petId.trim() && raw.petId.length <= 80
    ? raw.petId.trim()
    : defaults.petId;
  const size = normalizeDesktopPetSizePercent(raw.size, defaults.size);
  const workingBounceDistancePx = Math.round(clampNumber(
    raw.workingBounceDistancePx,
    DESKTOP_PET_WORK_BOUNCE_MIN_PX,
    DESKTOP_PET_WORK_BOUNCE_MAX_PX,
    defaults.workingBounceDistancePx
  ));
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled,
    petId,
    alwaysOnTop: typeof raw.alwaysOnTop === "boolean" ? raw.alwaysOnTop : defaults.alwaysOnTop,
    size,
    showActionMenu:
      typeof raw.showActionMenu === "boolean" ? raw.showActionMenu : defaults.showActionMenu,
    openOnHover: typeof raw.openOnHover === "boolean" ? raw.openOnHover : defaults.openOnHover,
    workingBounceEnabled:
      typeof raw.workingBounceEnabled === "boolean"
        ? raw.workingBounceEnabled
        : defaults.workingBounceEnabled,
    workingBounceDistancePx,
    showStatus: typeof raw.showStatus === "boolean" ? raw.showStatus : defaults.showStatus,
    showSessionName: typeof raw.showSessionName === "boolean" ? raw.showSessionName : defaults.showSessionName,
    autoHideFullscreen:
      typeof raw.autoHideFullscreen === "boolean" ? raw.autoHideFullscreen : defaults.autoHideFullscreen,
    lockPosition: typeof raw.lockPosition === "boolean" ? raw.lockPosition : defaults.lockPosition,
    position,
  };
}

let store: Store | null = null;
const TERMINAL_INPUT_SUGGESTION_USAGE_SAVE_DELAY_MS = 800;
let terminalInputSuggestionUsageSaveTimer: number | null = null;

async function getStore() {
  if (!store) {
    const paths = await getCliManagerDataPaths();
    store = await Store.load(paths.settingsStorePath, { autoSave: 0, defaults: {} });
  }
  return store;
}

async function applyDebugMode(enabled: boolean) {
  try {
    await invoke("set_debug_logging", { enabled });
  } catch (err) {
    if (enabled) {
      console.warn("Failed to set debug logging:", err);
    }
  }
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...DEFAULTS,
  resolvedTheme: resolveTheme(DEFAULTS.theme),
  loaded: false,
  terminalBackgroundMissing: false,

  load: singleFlight(async () => {
    const s = await getStore();
    const rawEntries = await s.entries();
    const entries = Object.fromEntries(
      rawEntries.filter(([, value]) => value !== null && value !== undefined)
    ) as Partial<Settings>;
    const pendingStoreWrites: Promise<void>[] = [];
    const persistSetting = (key: keyof Settings, value: Settings[keyof Settings]) => {
      pendingStoreWrites.push(s.set(key, value));
    };
    const osPlatformPromise = getOsPlatform();

    const theme = (entries.theme as ThemeMode) ?? DEFAULTS.theme;
    entries.language = migrateLanguagePreference(entries.language);
    entries.lastSettingsTab = migrateLastSettingsTab(entries.lastSettingsTab);
    const debugMode = (entries.debugMode as boolean) ?? DEFAULTS.debugMode;
    const storedTerminalThemeMode = entries.terminalThemeMode as unknown;
    const resolvedTheme = resolveTheme(theme);

    const storedLightThemePalette = entries.lightThemePalette;
    const lightThemePalette = migrateLightThemePalette(storedLightThemePalette) ?? DEFAULTS.lightThemePalette;
    if (typeof storedLightThemePalette === "string" && lightThemePalette !== storedLightThemePalette) {
      persistSetting("lightThemePalette", lightThemePalette);
    }
    entries.lightThemePalette = lightThemePalette;

    const storedDarkThemePalette = entries.darkThemePalette;
    const darkThemePalette = migrateDarkThemePalette(storedDarkThemePalette) ?? DEFAULTS.darkThemePalette;
    if (typeof storedDarkThemePalette === "string" && darkThemePalette !== storedDarkThemePalette) {
      persistSetting("darkThemePalette", darkThemePalette);
    }
    entries.darkThemePalette = darkThemePalette;

    const storedTerminalThemeName = entries.terminalThemeName;
    let terminalThemeName = migrateTerminalThemeName(storedTerminalThemeName) ?? DEFAULTS.terminalThemeName;
    if (typeof storedTerminalThemeName === "string" && terminalThemeName !== storedTerminalThemeName) {
      persistSetting("terminalThemeName", terminalThemeName);
    }

    const terminalThemeMode: TerminalThemeMode =
      storedTerminalThemeMode === "system" || storedTerminalThemeMode === "follow-app" || terminalThemeName === "auto"
        ? "system"
        : "independent";
    if (terminalThemeMode === "system" && terminalThemeName !== "auto") {
      terminalThemeName = "auto";
      persistSetting("terminalThemeName", terminalThemeName);
    }
    if (storedTerminalThemeMode !== terminalThemeMode) {
      persistSetting("terminalThemeMode", terminalThemeMode);
    }

    entries.terminalThemeName = terminalThemeName;
    entries.terminalThemeMode = terminalThemeMode;

    if (
      entries.uiTextColor !== undefined &&
      (typeof entries.uiTextColor !== "string" ||
        (entries.uiTextColor !== "" && !HEX_COLOR_PATTERN.test(entries.uiTextColor)))
    ) {
      entries.uiTextColor = DEFAULTS.uiTextColor;
      persistSetting("uiTextColor", DEFAULTS.uiTextColor);
    }
    entries.fontFamily =
      typeof entries.fontFamily === "string" && entries.fontFamily.trim()
        ? entries.fontFamily
        : DEFAULTS.fontFamily;
    entries.uiFontFamily =
      typeof entries.uiFontFamily === "string" && entries.uiFontFamily.trim()
        ? entries.uiFontFamily
        : DEFAULTS.uiFontFamily;
    entries.sidebarWidth = clampNumber(entries.sidebarWidth, 64, 500, DEFAULTS.sidebarWidth);
    entries.historySidebarWidth = clampNumber(entries.historySidebarWidth, 180, 520, DEFAULTS.historySidebarWidth);
    entries.uiFontSize = clampNumber(
      entries.uiFontSize,
      UI_FONT_SIZE_MIN,
      UI_FONT_SIZE_MAX,
      DEFAULTS.uiFontSize
    );
    entries.fontSize = clampNumber(
      entries.fontSize,
      TERMINAL_FONT_SIZE_MIN,
      TERMINAL_FONT_SIZE_MAX,
      DEFAULTS.fontSize
    );
    entries.terminalScrollbackRows = clampNumber(
      entries.terminalScrollbackRows,
      TERMINAL_SCROLLBACK_ROWS_MIN,
      TERMINAL_SCROLLBACK_ROWS_MAX,
      DEFAULTS.terminalScrollbackRows
    );
    entries.terminalScrollbackCustomEnabled =
      typeof entries.terminalScrollbackCustomEnabled === "boolean"
        ? entries.terminalScrollbackCustomEnabled
        : DEFAULTS.terminalScrollbackCustomEnabled;

    entries.keyboardShortcuts = migrateKeyboardShortcuts(entries.keyboardShortcuts);

    entries.collapsedGroupIds = Array.isArray(entries.collapsedGroupIds)
      ? entries.collapsedGroupIds.filter((id): id is string => typeof id === "string")
      : DEFAULTS.collapsedGroupIds;

    entries.terminalToolbarVisibility = migrateTerminalToolbarVisibility(entries.terminalToolbarVisibility);
    entries.sidebarToolbarVisibility = migrateSidebarToolbarVisibility(entries.sidebarToolbarVisibility);
    entries.terminalToolbarOrder = migrateTerminalToolbarOrder(entries.terminalToolbarOrder);
    entries.unsplitBehavior = migrateUnsplitBehavior(entries.unsplitBehavior);
    entries.terminalSidePanelMerged =
      typeof entries.terminalSidePanelMerged === "boolean"
        ? entries.terminalSidePanelMerged
        : DEFAULTS.terminalSidePanelMerged;
    entries.terminalSidePanelSingleOpen =
      typeof entries.terminalSidePanelSingleOpen === "boolean"
        ? entries.terminalSidePanelSingleOpen
        : DEFAULTS.terminalSidePanelSingleOpen;
    entries.terminalSidePanelSkin = migrateTerminalSidePanelSkin(entries.terminalSidePanelSkin);
    entries.terminalPanelWidths = migrateTerminalPanelWidths(entries.terminalPanelWidths);
    entries.terminalStatsCardVisibility = migrateTerminalStatsCardVisibility(entries.terminalStatsCardVisibility);
    entries.terminalStatsCardOrder = migrateTerminalStatsCardOrder(entries.terminalStatsCardOrder);
    entries.systemResourceCardVisibility = migrateSystemResourceCardVisibility(entries.systemResourceCardVisibility);
    entries.systemResourceCardOrder = migrateSystemResourceCardOrder(entries.systemResourceCardOrder);
    entries.terminalBackground = migrateTerminalBackground(entries.terminalBackground);
    entries.desktopPet = migrateDesktopPetSettings(entries.desktopPet);
    entries.terminalShellProfiles = migrateTerminalShellProfiles(entries.terminalShellProfiles);
    entries.terminalSettingsSectionsExpanded = migrateTerminalSettingsSectionsExpanded(
      entries.terminalSettingsSectionsExpanded
    );

    const currentDefaultShell = typeof entries.defaultShell === "string" ? entries.defaultShell.trim() : "";
    entries.defaultShell = currentDefaultShell || DEFAULTS.defaultShell;

    entries.shellRuntimeMonitoringEnabled =
      typeof entries.shellRuntimeMonitoringEnabled === "boolean"
        ? entries.shellRuntimeMonitoringEnabled
        : DEFAULTS.shellRuntimeMonitoringEnabled;
    entries.systemResourceMonitoringEnabled =
      typeof entries.systemResourceMonitoringEnabled === "boolean"
        ? entries.systemResourceMonitoringEnabled
        : DEFAULTS.systemResourceMonitoringEnabled;
    entries.useExternalTerminal =
      typeof entries.useExternalTerminal === "boolean"
        ? entries.useExternalTerminal
        : DEFAULTS.useExternalTerminal;
    entries.sidebarDensity =
      entries.sidebarDensity === "compact" || entries.sidebarDensity === "comfortable"
        ? entries.sidebarDensity
        : DEFAULTS.sidebarDensity;
    entries.sidebarProjectFilterVisible =
      typeof entries.sidebarProjectFilterVisible === "boolean"
        ? entries.sidebarProjectFilterVisible
        : DEFAULTS.sidebarProjectFilterVisible;
    entries.viewMode =
      entries.viewMode === "standard" || entries.viewMode === "compact"
        ? entries.viewMode
        : DEFAULTS.viewMode;
    entries.closeBehavior =
      entries.closeBehavior === "ask" || entries.closeBehavior === "minimize" || entries.closeBehavior === "exit"
        ? entries.closeBehavior
        : DEFAULTS.closeBehavior;
    entries.exitWithRunningTasksBehavior =
      entries.exitWithRunningTasksBehavior === "ask" ||
      entries.exitWithRunningTasksBehavior === "background" ||
      entries.exitWithRunningTasksBehavior === "minimize" ||
      entries.exitWithRunningTasksBehavior === "discard"
        ? entries.exitWithRunningTasksBehavior
        : DEFAULTS.exitWithRunningTasksBehavior;
    entries.backgroundIncludeFinishedTasks =
      typeof entries.backgroundIncludeFinishedTasks === "boolean"
        ? entries.backgroundIncludeFinishedTasks
        : DEFAULTS.backgroundIncludeFinishedTasks;
    entries.ccusageAnalyticsEnabled =
      typeof entries.ccusageAnalyticsEnabled === "boolean"
        ? entries.ccusageAnalyticsEnabled
        : DEFAULTS.ccusageAnalyticsEnabled;
    entries.ccusageUseWsl =
      typeof entries.ccusageUseWsl === "boolean"
        ? entries.ccusageUseWsl
        : DEFAULTS.ccusageUseWsl;
    entries.windowsConptyCompatibilityFixEnabled =
      typeof entries.windowsConptyCompatibilityFixEnabled === "boolean"
        ? entries.windowsConptyCompatibilityFixEnabled
        : DEFAULTS.windowsConptyCompatibilityFixEnabled;
    entries.terminalSessionRestoreEnabled =
      typeof entries.terminalSessionRestoreEnabled === "boolean"
        ? entries.terminalSessionRestoreEnabled
        : DEFAULTS.terminalSessionRestoreEnabled;
    entries.projectWorktreeConfigEnabled =
      typeof entries.projectWorktreeConfigEnabled === "boolean"
        ? entries.projectWorktreeConfigEnabled
        : DEFAULTS.projectWorktreeConfigEnabled;
    entries.symlinkCompatibilityEnabled =
      typeof entries.symlinkCompatibilityEnabled === "boolean"
        ? entries.symlinkCompatibilityEnabled
        : DEFAULTS.symlinkCompatibilityEnabled;
    entries.lowMemoryMode =
      typeof entries.lowMemoryMode === "boolean"
        ? entries.lowMemoryMode
        : DEFAULTS.lowMemoryMode;
    entries.disableHardwareAcceleration =
      typeof entries.disableHardwareAcceleration === "boolean"
        ? entries.disableHardwareAcceleration
        : DEFAULTS.disableHardwareAcceleration;
    entries.linuxGraphicsMode = LINUX_GRAPHICS_MODES.includes(entries.linuxGraphicsMode as LinuxGraphicsMode)
      ? entries.linuxGraphicsMode as LinuxGraphicsMode
      : DEFAULTS.linuxGraphicsMode;
    entries.terminalInputSuggestionsEnabled =
      typeof entries.terminalInputSuggestionsEnabled === "boolean"
        ? entries.terminalInputSuggestionsEnabled
        : DEFAULTS.terminalInputSuggestionsEnabled;
    const storedTerminalInputSuggestionProvider = entries.terminalInputSuggestionProvider;
    const storedTerminalInputSuggestionLlmEnabled = entries.terminalInputSuggestionLlmEnabled;
    entries.terminalInputSuggestionProvider = "local";
    entries.terminalInputSuggestionLlmEnabled = false;
    if (
      migrateTerminalInputSuggestionProvider(storedTerminalInputSuggestionProvider) !== "local" ||
      storedTerminalInputSuggestionLlmEnabled === true
    ) {
      persistSetting("terminalInputSuggestionProvider", "local");
      persistSetting("terminalInputSuggestionLlmEnabled", false);
    }
    entries.terminalInputSuggestionBaseUrl =
      typeof entries.terminalInputSuggestionBaseUrl === "string"
        ? entries.terminalInputSuggestionBaseUrl
        : DEFAULTS.terminalInputSuggestionBaseUrl;
    entries.terminalInputSuggestionApiKey =
      typeof entries.terminalInputSuggestionApiKey === "string"
        ? entries.terminalInputSuggestionApiKey
        : DEFAULTS.terminalInputSuggestionApiKey;
    entries.terminalInputSuggestionModel =
      typeof entries.terminalInputSuggestionModel === "string" && entries.terminalInputSuggestionModel.trim()
        ? entries.terminalInputSuggestionModel
        : DEFAULTS.terminalInputSuggestionModel;
    entries.terminalInputSuggestionUseBuiltinPrompt =
      typeof entries.terminalInputSuggestionUseBuiltinPrompt === "boolean"
        ? entries.terminalInputSuggestionUseBuiltinPrompt
        : DEFAULTS.terminalInputSuggestionUseBuiltinPrompt;
    entries.terminalInputSuggestionCustomPrompt =
      typeof entries.terminalInputSuggestionCustomPrompt === "string"
        ? entries.terminalInputSuggestionCustomPrompt
        : DEFAULTS.terminalInputSuggestionCustomPrompt;
    entries.terminalInputSuggestionUsage = migrateTerminalInputSuggestionUsage(entries.terminalInputSuggestionUsage);
    entries.terminalInputSuggestionLastTest = migrateTerminalInputSuggestionLastTest(entries.terminalInputSuggestionLastTest);

    entries.hookPopupNotificationsEnabled =
      typeof entries.hookPopupNotificationsEnabled === "boolean"
        ? entries.hookPopupNotificationsEnabled
        : DEFAULTS.hookPopupNotificationsEnabled;
    entries.hookPopupAutoCloseEnabled =
      typeof entries.hookPopupAutoCloseEnabled === "boolean"
        ? entries.hookPopupAutoCloseEnabled
        : DEFAULTS.hookPopupAutoCloseEnabled;
    entries.hookPopupAutoCloseSeconds = clampNumber(
      entries.hookPopupAutoCloseSeconds,
      5,
      3600,
      DEFAULTS.hookPopupAutoCloseSeconds
    );
    entries.hookSubagentSplitViewEnabled =
      typeof entries.hookSubagentSplitViewEnabled === "boolean"
        ? entries.hookSubagentSplitViewEnabled
        : DEFAULTS.hookSubagentSplitViewEnabled;
    entries.claudeHookBridgeEnabled =
      typeof entries.claudeHookBridgeEnabled === "boolean"
        ? entries.claudeHookBridgeEnabled
        : DEFAULTS.claudeHookBridgeEnabled;
    entries.codexHookBridgeEnabled =
      typeof entries.codexHookBridgeEnabled === "boolean"
        ? entries.codexHookBridgeEnabled
        : DEFAULTS.codexHookBridgeEnabled;
    entries.piHookBridgeEnabled =
      typeof entries.piHookBridgeEnabled === "boolean"
        ? entries.piHookBridgeEnabled
        : DEFAULTS.piHookBridgeEnabled;
    entries.systemNotificationsEnabled =
      typeof entries.systemNotificationsEnabled === "boolean"
        ? entries.systemNotificationsEnabled
        : DEFAULTS.systemNotificationsEnabled;
    entries.suppressSystemNotificationsWhenFocused =
      typeof entries.suppressSystemNotificationsWhenFocused === "boolean"
        ? entries.suppressSystemNotificationsWhenFocused
        : DEFAULTS.suppressSystemNotificationsWhenFocused;
    entries.systemNotificationEvents = migrateSystemNotificationEvents(entries.systemNotificationEvents);
    entries.hookSettingsSectionsExpanded = migrateHookSettingsSectionsExpanded(entries.hookSettingsSectionsExpanded);
    entries.thirdPartyHookNotificationsEnabled =
      typeof entries.thirdPartyHookNotificationsEnabled === "boolean"
        ? entries.thirdPartyHookNotificationsEnabled
        : DEFAULTS.thirdPartyHookNotificationsEnabled;
    entries.thirdPartyHookTargets = sanitizeThirdPartyHookTargets(entries.thirdPartyHookTargets);
    entries.remoteHandoffNotificationsEnabled =
      typeof entries.remoteHandoffNotificationsEnabled === "boolean"
        ? entries.remoteHandoffNotificationsEnabled
        : DEFAULTS.remoteHandoffNotificationsEnabled;
    entries.remoteHandoffCompletionNotificationsEnabled =
      typeof entries.remoteHandoffCompletionNotificationsEnabled === "boolean"
        ? entries.remoteHandoffCompletionNotificationsEnabled
        : DEFAULTS.remoteHandoffCompletionNotificationsEnabled;
    entries.remoteHandoffPermissionNotificationsEnabled =
      typeof entries.remoteHandoffPermissionNotificationsEnabled === "boolean"
        ? entries.remoteHandoffPermissionNotificationsEnabled
        : DEFAULTS.remoteHandoffPermissionNotificationsEnabled;
    entries.remoteHandoffProgressNotificationsEnabled =
      typeof entries.remoteHandoffProgressNotificationsEnabled === "boolean"
        ? entries.remoteHandoffProgressNotificationsEnabled
        : DEFAULTS.remoteHandoffProgressNotificationsEnabled;
    entries.remoteHandoffProgressIntervalMinutes =
      typeof entries.remoteHandoffProgressIntervalMinutes === "number"
        && Number.isFinite(entries.remoteHandoffProgressIntervalMinutes)
        ? Math.min(60, Math.max(1, Math.round(entries.remoteHandoffProgressIntervalMinutes)))
        : DEFAULTS.remoteHandoffProgressIntervalMinutes;
    entries.claudeHookConfigDir =
      typeof entries.claudeHookConfigDir === "string" && entries.claudeHookConfigDir.trim()
        ? entries.claudeHookConfigDir
        : null;
    entries.claudeHookAutoRepairKnownInstalled =
      typeof entries.claudeHookAutoRepairKnownInstalled === "boolean"
        ? entries.claudeHookAutoRepairKnownInstalled
        : DEFAULTS.claudeHookAutoRepairKnownInstalled;
    entries.claudeHookAutoRepairNoticeShown =
      typeof entries.claudeHookAutoRepairNoticeShown === "boolean"
        ? entries.claudeHookAutoRepairNoticeShown
        : DEFAULTS.claudeHookAutoRepairNoticeShown;
    entries.codexHookConfigDir =
      typeof entries.codexHookConfigDir === "string" && entries.codexHookConfigDir.trim()
        ? entries.codexHookConfigDir
        : null;
    entries.piHookConfigDir =
      typeof entries.piHookConfigDir === "string" && entries.piHookConfigDir.trim()
        ? entries.piHookConfigDir
        : null;
    entries.ccSwitchDbPath =
      typeof entries.ccSwitchDbPath === "string" && entries.ccSwitchDbPath.trim()
        ? entries.ccSwitchDbPath
        : null;
    entries.confirmBeforeClosingTerminalTab =
      typeof entries.confirmBeforeClosingTerminalTab === "boolean"
        ? entries.confirmBeforeClosingTerminalTab
        : DEFAULTS.confirmBeforeClosingTerminalTab;
    entries.terminalTabHoverInfoEnabled =
      typeof entries.terminalTabHoverInfoEnabled === "boolean"
        ? entries.terminalTabHoverInfoEnabled
        : DEFAULTS.terminalTabHoverInfoEnabled;
    entries.gitGroupBy =
      entries.gitGroupBy === "directory" || entries.gitGroupBy === "module"
        ? entries.gitGroupBy
        : DEFAULTS.gitGroupBy;
    entries.fileExplorerIgnoredPaths = migrateFileExplorerIgnoredPaths(entries.fileExplorerIgnoredPaths);
    entries.batchLaunchGroupInPane =
      typeof entries.batchLaunchGroupInPane === "boolean"
        ? entries.batchLaunchGroupInPane
        : DEFAULTS.batchLaunchGroupInPane;
    entries.batchLaunchPaneDirection =
      entries.batchLaunchPaneDirection === "vertical" || entries.batchLaunchPaneDirection === "horizontal"
        ? entries.batchLaunchPaneDirection
        : DEFAULTS.batchLaunchPaneDirection;
    entries.terminalNewlineShortcut =
      entries.terminalNewlineShortcut === "Shift+Enter" ||
      entries.terminalNewlineShortcut === "Ctrl+Enter" ||
      entries.terminalNewlineShortcut === "Alt+Enter"
        ? entries.terminalNewlineShortcut
        : DEFAULTS.terminalNewlineShortcut;
    entries.projectScopedTerminalViewEnabled =
      typeof entries.projectScopedTerminalViewEnabled === "boolean"
        ? entries.projectScopedTerminalViewEnabled
        : DEFAULTS.projectScopedTerminalViewEnabled;
    entries.workspanEnabled =
      typeof entries.workspanEnabled === "boolean"
        ? entries.workspanEnabled
        : DEFAULTS.workspanEnabled;

    if (pendingStoreWrites.length > 0) {
      await Promise.all(pendingStoreWrites);
    }

    set({ ...entries, resolvedTheme, loaded: true, terminalBackgroundMissing: false });
    void applyDebugMode(debugMode);

    const initialDefaultShell = entries.defaultShell;
    void osPlatformPromise
      .then(async (os) => {
        const platformDefaultShell = defaultShellForOs(os);
        if (!currentDefaultShell || (os !== "windows" && isWindowsOnlyShellKey(currentDefaultShell))) {
          if (get().defaultShell !== initialDefaultShell) return;
          await s.set("defaultShell", platformDefaultShell);
          set({ defaultShell: platformDefaultShell });
        }
      })
      .catch(() => {});

    const configuredBackground = entries.terminalBackground;
    if (configuredBackground.enabled && configuredBackground.imagePath) {
      const expectedImagePath = configuredBackground.imagePath;
      void backgroundImageExists(expectedImagePath)
        .then((exists) => {
          if (exists) return;
          const currentBackground = get().terminalBackground;
          if (
            !currentBackground.enabled ||
            currentBackground.imagePath !== expectedImagePath
          ) {
            return;
          }
          set({
            terminalBackground: { ...currentBackground, imagePath: null },
            terminalBackgroundMissing: true,
          });
        })
        .catch(() => {});
    }
  }),

  syncSystemTheme: () => {
    if (get().theme === "system") {
      set({ resolvedTheme: getSystemTheme() });
    }
  },

  update: async (key, value) => {
    const s = await getStore();
    await s.set(key, value);
    set({ [key]: value } as Partial<SettingsStore>);
    if (key === "debugMode") {
      void applyDebugMode(value as boolean);
    }
  },

  recordTerminalInputSuggestionUsage: (event) => {
    const next = mergeTerminalInputSuggestionUsage(get().terminalInputSuggestionUsage, event);
    set({ terminalInputSuggestionUsage: next });
    if (terminalInputSuggestionUsageSaveTimer !== null) {
      window.clearTimeout(terminalInputSuggestionUsageSaveTimer);
    }
    terminalInputSuggestionUsageSaveTimer = window.setTimeout(() => {
      terminalInputSuggestionUsageSaveTimer = null;
      void getStore()
        .then((s) => s.set("terminalInputSuggestionUsage", get().terminalInputSuggestionUsage))
        .catch(() => {});
    }, TERMINAL_INPUT_SUGGESTION_USAGE_SAVE_DELAY_MS);
  },

  setTheme: async (mode) => {
    const s = await getStore();
    await s.set("theme", mode);
    set({ theme: mode, resolvedTheme: resolveTheme(mode) });
  },

  setTerminalThemeMode: async (mode) => {
    const s = await getStore();
    const current = get();
    let nextThemeName = current.terminalThemeName;

    if (mode === "system") {
      await s.set("terminalThemeMode", "system");
      await s.set("terminalThemeName", "auto");
      set({ terminalThemeMode: "system", terminalThemeName: "auto" });
      return;
    }

    if (nextThemeName === "auto") {
      nextThemeName = resolveAutoTerminalThemeId(
        current.resolvedTheme,
        current.lightThemePalette,
        current.darkThemePalette
      );
      await s.set("terminalThemeName", nextThemeName);
    }

    await s.set("terminalThemeMode", "independent");
    set({ terminalThemeMode: "independent", terminalThemeName: nextThemeName });
  },

  clearTerminalBackgroundMissing: () => {
    set({ terminalBackgroundMissing: false });
  },
}));
