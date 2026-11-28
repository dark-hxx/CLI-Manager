// Appearance preference contracts and navigation IDs; settingsStore keeps the public compatibility exports.
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
  | "apple-mono"
  | "code-daylight"
  | "nord-snow"
  | "rose-dawn";
export type DarkThemePalette =
  | "night-indigo"
  | "forest-night"
  | "graphite-red"
  | "investment-platform"
  | "github-dark"
  | "catppuccin-mocha"
  | "terminal-green"
  | "dracula-purple"
  | "carbon-black"
  | "code-midnight"
  | "nord-frost"
  | "rose-moon";
export type TerminalThemeMode = "system" | "independent";
export type SidebarDensity = "compact" | "comfortable";
export type ViewMode = "standard" | "compact";

/** 设置页图标风格：refined 为自绘彩色圆角砖，classic 恢复 lucide 线性图标。 */
export type SettingsIconStyle = "classic" | "refined";

export type LastSettingsTab =
  | "general"
  | "extensions"
  | "desktop-pet"
  | "developer"
  | "sidebar"
  | "terminal-theme"
  | "shortcuts"
  | "templates"
  | "native-providers"
  | "sponsors"
  | "model-pricing"
  | "cc-connect" // Legacy persisted ID for the Web remote-connections page.
  | "ssh-hosts"
  | "proxy"
  | "sync"
  | "history-sources"
  | "hooks"
  | "statusline"
  | "terminal-status-bar"
  | "command-suggestions"
  | "about";

export type TerminalSidePanelSkin = "terminal" | "classic-terminal" | "warm-paper" | "sunrise" | "linen" | "latte";
export type TerminalStatsCardKey =
  | "session"
  | "tokenUsage"
  | "tokenTrend"
  | "modelContext"
  | "tools"
  | "agentCapabilities"
  | "latestChanges"
  | "todayUsage";

export const LAST_SETTINGS_TABS: readonly LastSettingsTab[] = [
  "general",
  "extensions",
  "desktop-pet",
  "developer",
  "sidebar",
  "terminal-theme",
  "shortcuts",
  "templates",
  "native-providers",
  "sponsors",
  "model-pricing",
  "cc-connect",
  "ssh-hosts",
  "proxy",
  "sync",
  "history-sources",
  "hooks",
  "statusline",
  "terminal-status-bar",
  "command-suggestions",
  "about",
];
