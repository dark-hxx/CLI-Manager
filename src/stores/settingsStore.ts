import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { resolveAutoTerminalThemeId } from "../lib/terminalThemes";
import { backgroundImageExists } from "../lib/assetUrl";
import { defaultShellForOs, getOsPlatform, isWindowsOnlyShellKey } from "../lib/shell";

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
export type TerminalThemeMode = "follow-app" | "independent";
export type SidebarDensity = "compact" | "comfortable";
export type ViewMode = "standard" | "compact";
export type CloseBehavior = "ask" | "minimize" | "exit";
type LastSettingsTab =
  | "general"
  | "sidebar"
  | "terminal-theme"
  | "shortcuts"
  | "templates"
  | "providers"
  | "model-pricing"
  | "sync"
  | "hooks"
  | "about";
export type TerminalSidePanelSkin = "terminal" | "classic-terminal" | "warm-paper" | "sunrise" | "linen" | "latte";
export type TerminalStatsCardKey =
  | "session"
  | "tokenUsage"
  | "tokenTrend"
  | "modelContext"
  | "tools"
  | "latestChanges"
  | "todayUsage";
export const UI_FONT_SIZE_MIN = 11;
export const UI_FONT_SIZE_MAX = 18;
export const UI_FONT_SIZE_DEFAULT = 13;
export const TERMINAL_SCROLLBACK_ROWS_MIN = 1000;
export const TERMINAL_SCROLLBACK_ROWS_MAX = 50000;
export const TERMINAL_SCROLLBACK_ROWS_DEFAULT = 5000;
export type ShortcutAction =
  | "newTerminal"
  | "closeTerminal"
  | "nextTab"
  | "prevTab"
  | "commandPalette"
  | "sessionHistory"
  | "copyAi"
  | "toggleTerminalFullscreen";
export type TabSwitchShortcutModifier = "Alt" | "Ctrl" | "Shift";
export type KeyboardShortcutMap = Record<ShortcutAction, string>;
export type TerminalNewlineShortcut = "Shift+Enter" | "Ctrl+Enter" | "Alt+Enter";
export type UnsplitBehavior = "merge" | "close";
export type FileExplorerIgnoredPaths = Record<string, string[]>;
export type LanguagePreference = "auto" | "zh-CN" | "en-US";
export type BatchLaunchPaneDirection = "vertical" | "horizontal";

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
  "toggleTerminalFullscreen",
];

export interface TerminalToolbarVisibilitySettings {
  templates: boolean;
  commandHistory: boolean;
  fullscreen: boolean;
  sessionHistory: boolean;
  replay: boolean;
  files: boolean;
  stats: boolean;
  gitChanges: boolean;
  showText: boolean;
}

export interface SidebarToolbarVisibilitySettings {
  stats: boolean;
  gitChanges: boolean;
}

export type TerminalStatsCardVisibilitySettings = Record<TerminalStatsCardKey, boolean>;
export type TerminalStatsCardOrderSettings = TerminalStatsCardKey[];

export const TERMINAL_STATS_CARD_KEYS: readonly TerminalStatsCardKey[] = [
  "session",
  "tokenUsage",
  "tokenTrend",
  "modelContext",
  "tools",
  "latestChanges",
  "todayUsage",
];

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutMap = {
  newTerminal: "Ctrl+Shift+T",
  closeTerminal: "Ctrl+W",
  nextTab: "Alt+ArrowRight",
  prevTab: "Alt+ArrowLeft",
  commandPalette: "Ctrl+P",
  sessionHistory: "Ctrl+K",
  copyAi: "Alt+P",
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

interface Settings {
  language: LanguagePreference;
  theme: ThemeMode;
  lightThemePalette: LightThemePalette;
  darkThemePalette: DarkThemePalette;
  fontSize: number;
  terminalScrollbackRows: number;
  fontFamily: string;
  uiFontFamily: string;
  uiFontSize: number;
  uiTextColor: string;
  lastSettingsTab: LastSettingsTab;
  defaultShell: string;
  sidebarWidth: number;
  historySidebarWidth: number;
  collapsedGroupIds: string[];
  useExternalTerminal: boolean;
  debugMode: boolean;
  terminalThemeMode: TerminalThemeMode;
  terminalThemeName: string;
  sidebarDensity: SidebarDensity;
  viewMode: ViewMode;
  closeBehavior: CloseBehavior;
  keyboardShortcuts: KeyboardShortcutMap;
  terminalNewlineShortcut: TerminalNewlineShortcut;
  unsplitBehavior: UnsplitBehavior;
  terminalToolbarVisibility: TerminalToolbarVisibilitySettings;
  sidebarToolbarVisibility: SidebarToolbarVisibilitySettings;
  terminalToolbarOrder: string[];
  /** 是否把实时统计与 Git 变更合并为带 Tab 的单一侧边面板；关闭后两者可并排独立显示。 */
  terminalSidePanelMerged: boolean;
  terminalSidePanelSkin: TerminalSidePanelSkin;
  terminalStatsCardVisibility: TerminalStatsCardVisibilitySettings;
  terminalStatsCardOrder: TerminalStatsCardOrderSettings;
  shellRuntimeMonitoringEnabled: boolean;
  ccusageAnalyticsEnabled: boolean;
  ccusageUseWsl: boolean;
  terminalBackground: TerminalBackgroundSettings;
  hookPopupNotificationsEnabled: boolean;
  hookPopupAutoCloseEnabled: boolean;
  hookPopupAutoCloseSeconds: number;
  hookSubagentSplitViewEnabled: boolean;
  systemNotificationsEnabled: boolean;
  systemNotificationEvents: Record<HookEventType, boolean>;
  claudeHookConfigDir: string | null;
  claudeHookAutoRepairKnownInstalled: boolean;
  claudeHookAutoRepairNoticeShown: boolean;
  codexHookConfigDir: string | null;
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
}

interface SettingsStore extends Settings {
  resolvedTheme: "dark" | "light";
  loaded: boolean;
  /** Transient flag: set when the saved terminal background image was not found on disk at load. */
  terminalBackgroundMissing: boolean;
  load: () => Promise<void>;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
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
  fontSize: 14,
  terminalScrollbackRows: TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  fontFamily: "Cascadia Code, Consolas, monospace",
  uiFontFamily:
    "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
  uiFontSize: UI_FONT_SIZE_DEFAULT,
  uiTextColor: "",
  lastSettingsTab: "general",
  defaultShell: "powershell.exe",
  sidebarWidth: 248,
  historySidebarWidth: 276,
  collapsedGroupIds: [],
  useExternalTerminal: false,
  debugMode: false,
  terminalThemeMode: "follow-app",
  terminalThemeName: "auto",
  sidebarDensity: "comfortable",
  viewMode: "standard",
  closeBehavior: "ask",
  keyboardShortcuts: DEFAULT_KEYBOARD_SHORTCUTS,
  terminalNewlineShortcut: "Shift+Enter",
  unsplitBehavior: "merge",
  terminalToolbarVisibility: {
    templates: true,
    commandHistory: true,
    fullscreen: true,
    sessionHistory: true,
    replay: false,
    files: true,
    stats: true,
    gitChanges: true,
    showText: false,
  },
  sidebarToolbarVisibility: {
    stats: true,
    gitChanges: true,
  },
  terminalToolbarOrder: ["new", "templates", "commandHistory", "fullscreen", "sessionHistory", "replay", "files", "gitChanges", "stats"],
  terminalSidePanelMerged: true,
  terminalSidePanelSkin: "terminal",
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
  shellRuntimeMonitoringEnabled: false,
  ccusageAnalyticsEnabled: false,
  ccusageUseWsl: false,
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
  hookPopupNotificationsEnabled: true,
  hookPopupAutoCloseEnabled: true,
  hookPopupAutoCloseSeconds: 60,
  hookSubagentSplitViewEnabled: true,
  systemNotificationsEnabled: true,
  systemNotificationEvents: {
    SessionStart: false,
    UserPromptSubmit: false,
    Notification: true,
    Stop: true,
    StopFailure: true,
    PermissionRequest: true,
  },
  claudeHookConfigDir: null,
  claudeHookAutoRepairKnownInstalled: false,
  claudeHookAutoRepairNoticeShown: false,
  codexHookConfigDir: null,
  ccSwitchDbPath: null,
  gitGroupBy: "directory",
  confirmBeforeClosingTerminalTab: false,
  terminalTabHoverInfoEnabled: true,
  fileExplorerIgnoredPaths: {},
  batchLaunchGroupInPane: false,
  batchLaunchPaneDirection: "horizontal",
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
  "sidebar",
  "terminal-theme",
  "shortcuts",
  "templates",
  "providers",
  "model-pricing",
  "sync",
  "hooks",
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
    commandHistory: typeof raw.commandHistory === "boolean" ? raw.commandHistory : defaults.commandHistory,
    fullscreen: typeof raw.fullscreen === "boolean" ? raw.fullscreen : defaults.fullscreen,
    sessionHistory: typeof raw.sessionHistory === "boolean" ? raw.sessionHistory : defaults.sessionHistory,
    replay: typeof raw.replay === "boolean" ? raw.replay : defaults.replay,
    files: typeof raw.files === "boolean" ? raw.files : defaults.files,
    stats: typeof raw.stats === "boolean" ? raw.stats : defaults.stats,
    gitChanges: typeof raw.gitChanges === "boolean" ? raw.gitChanges : defaults.gitChanges,
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

function migrateUnsplitBehavior(value: unknown): UnsplitBehavior {
  return value === "close" || value === "merge" ? value : DEFAULTS.unsplitBehavior;
}

function migrateLanguagePreference(value: unknown): LanguagePreference {
  return value === "auto" || value === "zh-CN" || value === "en-US" ? value : DEFAULTS.language;
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

let store: Store | null = null;
async function getStore() {
  if (!store) {
    store = await Store.load("settings.json", { autoSave: 100, defaults: {} });
  }
  return store;
}

async function applyDebugMode(enabled: boolean) {
  try {
    await invoke("set_debug_logging", { enabled });
  } catch (err) {
    console.warn("Failed to set debug logging:", err);
  }
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...DEFAULTS,
  resolvedTheme: resolveTheme(DEFAULTS.theme),
  loaded: false,
  terminalBackgroundMissing: false,

  load: async () => {
    const s = await getStore();
    const entries: Partial<Settings> = {};
    for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      const val = await s.get<Settings[typeof key]>(key);
      if (val !== null && val !== undefined) {
        (entries as Record<string, unknown>)[key] = val;
      }
    }

    const theme = (entries.theme as ThemeMode) ?? DEFAULTS.theme;
    entries.language = migrateLanguagePreference(entries.language);
    entries.lastSettingsTab = migrateLastSettingsTab(entries.lastSettingsTab);
    const debugMode = (entries.debugMode as boolean) ?? DEFAULTS.debugMode;
    const storedTerminalThemeMode = entries.terminalThemeMode as TerminalThemeMode | undefined;
    const resolvedTheme = resolveTheme(theme);

    const storedLightThemePalette = entries.lightThemePalette;
    const lightThemePalette = migrateLightThemePalette(storedLightThemePalette) ?? DEFAULTS.lightThemePalette;
    if (typeof storedLightThemePalette === "string" && lightThemePalette !== storedLightThemePalette) {
      await s.set("lightThemePalette", lightThemePalette);
    }
    entries.lightThemePalette = lightThemePalette;

    const storedDarkThemePalette = entries.darkThemePalette;
    const darkThemePalette = migrateDarkThemePalette(storedDarkThemePalette) ?? DEFAULTS.darkThemePalette;
    if (typeof storedDarkThemePalette === "string" && darkThemePalette !== storedDarkThemePalette) {
      await s.set("darkThemePalette", darkThemePalette);
    }
    entries.darkThemePalette = darkThemePalette;

    const storedTerminalThemeName = entries.terminalThemeName;
    let terminalThemeName = migrateTerminalThemeName(storedTerminalThemeName) ?? DEFAULTS.terminalThemeName;
    if (typeof storedTerminalThemeName === "string" && terminalThemeName !== storedTerminalThemeName) {
      await s.set("terminalThemeName", terminalThemeName);
    }

    const terminalThemeMode =
      storedTerminalThemeMode ??
      (terminalThemeName !== "auto" ? "independent" : "follow-app");

    if (terminalThemeMode === "independent" && terminalThemeName === "auto") {
      terminalThemeName = resolveAutoTerminalThemeId(resolvedTheme, lightThemePalette, darkThemePalette);
      await s.set("terminalThemeName", terminalThemeName);
    }

    entries.terminalThemeName = terminalThemeName;
    entries.terminalThemeMode = terminalThemeMode;

    if (
      entries.uiTextColor !== undefined &&
      (typeof entries.uiTextColor !== "string" ||
        (entries.uiTextColor !== "" && !HEX_COLOR_PATTERN.test(entries.uiTextColor)))
    ) {
      entries.uiTextColor = DEFAULTS.uiTextColor;
      await s.set("uiTextColor", DEFAULTS.uiTextColor);
    }
    entries.uiFontSize = clampNumber(
      entries.uiFontSize,
      UI_FONT_SIZE_MIN,
      UI_FONT_SIZE_MAX,
      DEFAULTS.uiFontSize
    );
    entries.terminalScrollbackRows = clampNumber(
      entries.terminalScrollbackRows,
      TERMINAL_SCROLLBACK_ROWS_MIN,
      TERMINAL_SCROLLBACK_ROWS_MAX,
      DEFAULTS.terminalScrollbackRows
    );

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
    entries.terminalSidePanelSkin = migrateTerminalSidePanelSkin(entries.terminalSidePanelSkin);
    entries.terminalStatsCardVisibility = migrateTerminalStatsCardVisibility(entries.terminalStatsCardVisibility);
    entries.terminalStatsCardOrder = migrateTerminalStatsCardOrder(entries.terminalStatsCardOrder);
    entries.terminalBackground = migrateTerminalBackground(entries.terminalBackground);

    // 默认 Shell：非 Windows 上迁移旧 Windows-only 默认值，避免 macOS/Linux 继续显示或启动 powershell.exe。
    try {
      const os = await getOsPlatform();
      const platformDefaultShell = defaultShellForOs(os);
      const currentDefaultShell = typeof entries.defaultShell === "string" ? entries.defaultShell.trim() : "";
      if (!currentDefaultShell || (os !== "windows" && isWindowsOnlyShellKey(currentDefaultShell))) {
        entries.defaultShell = platformDefaultShell;
        await s.set("defaultShell", platformDefaultShell);
      } else {
        entries.defaultShell = currentDefaultShell;
      }
    } catch {
      if (entries.defaultShell === undefined) {
        entries.defaultShell = DEFAULTS.defaultShell;
      }
    }

    entries.shellRuntimeMonitoringEnabled =
      typeof entries.shellRuntimeMonitoringEnabled === "boolean"
        ? entries.shellRuntimeMonitoringEnabled
        : DEFAULTS.shellRuntimeMonitoringEnabled;
    entries.ccusageAnalyticsEnabled =
      typeof entries.ccusageAnalyticsEnabled === "boolean"
        ? entries.ccusageAnalyticsEnabled
        : DEFAULTS.ccusageAnalyticsEnabled;
    entries.ccusageUseWsl =
      typeof entries.ccusageUseWsl === "boolean"
        ? entries.ccusageUseWsl
        : DEFAULTS.ccusageUseWsl;

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
    entries.systemNotificationsEnabled =
      typeof entries.systemNotificationsEnabled === "boolean"
        ? entries.systemNotificationsEnabled
        : DEFAULTS.systemNotificationsEnabled;
    entries.systemNotificationEvents = migrateSystemNotificationEvents(entries.systemNotificationEvents);
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
    entries.fileExplorerIgnoredPaths = migrateFileExplorerIgnoredPaths(entries.fileExplorerIgnoredPaths);
    entries.batchLaunchGroupInPane =
      typeof entries.batchLaunchGroupInPane === "boolean"
        ? entries.batchLaunchGroupInPane
        : DEFAULTS.batchLaunchGroupInPane;
    entries.batchLaunchPaneDirection =
      entries.batchLaunchPaneDirection === "vertical" || entries.batchLaunchPaneDirection === "horizontal"
        ? entries.batchLaunchPaneDirection
        : DEFAULTS.batchLaunchPaneDirection;

    // 检测背景图是否仍存在；若不存在，仅在内存中清空 imagePath，保留 settings.json
    // 中的原配置，便于后续提示用户「之前选的图丢了」。
    let terminalBackgroundMissing = false;
    let runtimeTerminalBackground = entries.terminalBackground;
    if (entries.terminalBackground.enabled && entries.terminalBackground.imagePath) {
      const exists = await backgroundImageExists(entries.terminalBackground.imagePath);
      if (!exists) {
        terminalBackgroundMissing = true;
        runtimeTerminalBackground = { ...entries.terminalBackground, imagePath: null };
      }
    }
    entries.terminalBackground = runtimeTerminalBackground;

    set({ ...entries, resolvedTheme, loaded: true, terminalBackgroundMissing });
    void applyDebugMode(debugMode);
  },

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

  setTheme: async (mode) => {
    const s = await getStore();
    await s.set("theme", mode);
    set({ theme: mode, resolvedTheme: resolveTheme(mode) });
  },

  setTerminalThemeMode: async (mode) => {
    const s = await getStore();
    const current = get();
    let nextThemeName = current.terminalThemeName;

    if (mode === "independent" && nextThemeName === "auto") {
      nextThemeName = resolveAutoTerminalThemeId(
        current.resolvedTheme,
        current.lightThemePalette,
        current.darkThemePalette
      );
      await s.set("terminalThemeName", nextThemeName);
    }

    await s.set("terminalThemeMode", mode);
    set({ terminalThemeMode: mode, terminalThemeName: nextThemeName });
  },

  clearTerminalBackgroundMissing: () => {
    set({ terminalBackgroundMissing: false });
  },
}));
