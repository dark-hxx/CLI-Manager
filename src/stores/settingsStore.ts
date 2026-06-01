import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { resolveAutoTerminalThemeId } from "../lib/terminalThemes";
import { backgroundImageExists } from "../lib/assetUrl";

export type ThemeMode = "dark" | "light" | "system";
export type LightThemePalette =
  | "warm-paper"
  | "cream-green"
  | "ink-red"
  | "saas-analytics-dashboard"
  | "apple-pure"
  | "apple-mist"
  | "apple-warm"
  | "apple-mono";
export type DarkThemePalette = "night-indigo" | "forest-night" | "graphite-red" | "investment-platform";
export type TerminalThemeMode = "follow-app" | "independent";
export type SidebarDensity = "compact" | "comfortable";
export type ViewMode = "standard" | "compact";
export type CloseBehavior = "ask" | "minimize" | "exit";
export type ShortcutAction = "newTerminal" | "closeTerminal" | "nextTab" | "prevTab" | "commandPalette";
export type TabSwitchShortcutModifier = "Alt" | "Ctrl" | "Shift";
export type KeyboardShortcutMap = Record<ShortcutAction, string>;
export type TerminalNewlineShortcut = "Shift+Enter" | "Ctrl+Enter" | "Alt+Enter";

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutMap = {
  newTerminal: "Ctrl+Shift+T",
  closeTerminal: "Ctrl+W",
  nextTab: "Alt+ArrowRight",
  prevTab: "Alt+ArrowLeft",
  commandPalette: "Ctrl+P",
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
  theme: ThemeMode;
  lightThemePalette: LightThemePalette;
  darkThemePalette: DarkThemePalette;
  fontSize: number;
  fontFamily: string;
  uiFontFamily: string;
  uiTextColor: string;
  defaultShell: string;
  sidebarWidth: number;
  historySidebarWidth: number;
  useExternalTerminal: boolean;
  debugMode: boolean;
  terminalThemeMode: TerminalThemeMode;
  terminalThemeName: string;
  sidebarDensity: SidebarDensity;
  viewMode: ViewMode;
  closeBehavior: CloseBehavior;
  keyboardShortcuts: KeyboardShortcutMap;
  terminalNewlineShortcut: TerminalNewlineShortcut;
  terminalBackground: TerminalBackgroundSettings;
  hookPopupNotificationsEnabled: boolean;
  hookPopupAutoCloseEnabled: boolean;
  hookPopupAutoCloseSeconds: number;
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
  theme: "system",
  lightThemePalette: "warm-paper",
  darkThemePalette: "night-indigo",
  fontSize: 14,
  fontFamily: "Cascadia Code, Consolas, monospace",
  uiFontFamily:
    "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
  uiTextColor: "",
  defaultShell: "powershell.exe",
  sidebarWidth: 280,
  historySidebarWidth: 300,
  useExternalTerminal: false,
  debugMode: false,
  terminalThemeMode: "follow-app",
  terminalThemeName: "auto",
  sidebarDensity: "comfortable",
  viewMode: "standard",
  closeBehavior: "ask",
  keyboardShortcuts: DEFAULT_KEYBOARD_SHORTCUTS,
  terminalNewlineShortcut: "Shift+Enter",
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
};

const LEGACY_LIGHT_PALETTE_MAP: Partial<Record<string, LightThemePalette>> = {
  "luxury-commerce": "saas-analytics-dashboard",
};

const LEGACY_DARK_PALETTE_MAP: Partial<Record<string, DarkThemePalette>> = {
  "crypto-wallet": "investment-platform",
};

const LEGACY_TERMINAL_THEME_MAP: Partial<Record<string, string>> = {
  luxuryCommerceLight: "saasAnalyticsDashboardLight",
  cryptoWalletDark: "investmentPlatformDark",
};

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

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
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

    if (entries.keyboardShortcuts) {
      entries.keyboardShortcuts = { ...DEFAULTS.keyboardShortcuts, ...entries.keyboardShortcuts };
    }

    entries.terminalBackground = migrateTerminalBackground(entries.terminalBackground);

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
