export type TerminalSettingsSectionKey = "behavior" | "paneMarker" | "shells" | "themes" | "previewTheme" | "background";
export type TerminalSettingsSectionsExpanded = Record<TerminalSettingsSectionKey, boolean>;
export type SidebarSettingsSectionKey = "behavior" | "panelSkin" | "statsCards" | "resourceCards" | "toolbar";
export type SidebarSettingsSectionsExpanded = Record<SidebarSettingsSectionKey, boolean>;
export type HookSettingsSectionKey =
  | "toast"
  | "notifications"
  | "claude"
  | "codex"
  | "kimi"
  | "pi"
  | "grok"
  | "antigravity";
export type HookSettingsSectionsExpanded = Record<HookSettingsSectionKey, boolean>;

export const TERMINAL_SETTINGS_SECTION_KEYS: readonly TerminalSettingsSectionKey[] = [
  "behavior",
  "paneMarker",
  "shells",
  "themes",
  "previewTheme",
  "background",
];
export const TERMINAL_SETTINGS_SECTIONS_EXPANDED_DEFAULT: TerminalSettingsSectionsExpanded = {
  behavior: true,
  paneMarker: false,
  shells: false,
  themes: false,
  previewTheme: false,
  background: false,
};
export const SIDEBAR_SETTINGS_SECTION_KEYS: readonly SidebarSettingsSectionKey[] = [
  "behavior",
  "panelSkin",
  "statsCards",
  "resourceCards",
  "toolbar",
];
export const SIDEBAR_SETTINGS_SECTIONS_EXPANDED_DEFAULT: SidebarSettingsSectionsExpanded = {
  behavior: true,
  panelSkin: false,
  statsCards: false,
  resourceCards: false,
  toolbar: false,
};
export const HOOK_SETTINGS_SECTION_KEYS: readonly HookSettingsSectionKey[] = [
  "toast",
  "notifications",
  "claude",
  "codex",
  "kimi",
  "pi",
  "grok",
  "antigravity",
];
export const HOOK_SETTINGS_SECTIONS_EXPANDED_DEFAULT: HookSettingsSectionsExpanded = {
  toast: false,
  notifications: false,
  claude: false,
  codex: false,
  kimi: false,
  pi: false,
  grok: false,
  antigravity: false,
};

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

export function migrateSidebarSettingsSectionsExpanded(value: unknown): SidebarSettingsSectionsExpanded {
  const defaults = SIDEBAR_SETTINGS_SECTIONS_EXPANDED_DEFAULT;
  if (typeof value !== "object" || value === null) {
    return { ...defaults };
  }
  const raw = value as Partial<Record<SidebarSettingsSectionKey, unknown>>;
  return SIDEBAR_SETTINGS_SECTION_KEYS.reduce<SidebarSettingsSectionsExpanded>((next, key) => {
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
