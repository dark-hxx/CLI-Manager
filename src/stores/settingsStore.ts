import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { resolveAutoTerminalThemeId } from "../lib/terminalThemes";

export type ThemeMode = "dark" | "light" | "system";
export type LightThemePalette = "warm-paper" | "cream-green" | "ink-red";
export type DarkThemePalette = "night-indigo" | "forest-night" | "graphite-red";
export type TerminalThemeMode = "follow-app" | "independent";
export type SidebarDensity = "compact" | "comfortable";
export type ViewMode = "standard" | "compact";
export type ShortcutAction = "newTerminal" | "closeTerminal" | "nextTab" | "prevTab" | "commandPalette";
export type KeyboardShortcutMap = Record<ShortcutAction, string>;

interface Settings {
  theme: ThemeMode;
  lightThemePalette: LightThemePalette;
  darkThemePalette: DarkThemePalette;
  fontSize: number;
  fontFamily: string;
  defaultShell: string;
  sidebarWidth: number;
  historySidebarWidth: number;
  useExternalTerminal: boolean;
  debugMode: boolean;
  terminalThemeMode: TerminalThemeMode;
  terminalThemeName: string;
  sidebarDensity: SidebarDensity;
  viewMode: ViewMode;
  keyboardShortcuts: KeyboardShortcutMap;
}

interface SettingsStore extends Settings {
  resolvedTheme: "dark" | "light";
  loaded: boolean;
  load: () => Promise<void>;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
  setTheme: (mode: ThemeMode) => Promise<void>;
  setTerminalThemeMode: (mode: TerminalThemeMode) => Promise<void>;
}

const DEFAULTS: Settings = {
  theme: "system",
  lightThemePalette: "warm-paper",
  darkThemePalette: "night-indigo",
  fontSize: 14,
  fontFamily: "Cascadia Code, Consolas, monospace",
  defaultShell: "powershell.exe",
  sidebarWidth: 280,
  historySidebarWidth: 300,
  useExternalTerminal: false,
  debugMode: false,
  terminalThemeMode: "follow-app",
  terminalThemeName: "auto",
  sidebarDensity: "comfortable",
  viewMode: "standard",
  keyboardShortcuts: {
    newTerminal: "Ctrl+Shift+T",
    closeTerminal: "Ctrl+W",
    nextTab: "Ctrl+Tab",
    prevTab: "Ctrl+Shift+Tab",
    commandPalette: "Ctrl+P",
  },
};

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(mode: ThemeMode): "dark" | "light" {
  return mode === "system" ? getSystemTheme() : mode;
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
    const lightThemePalette = (entries.lightThemePalette as LightThemePalette | undefined) ?? DEFAULTS.lightThemePalette;
    const darkThemePalette = (entries.darkThemePalette as DarkThemePalette | undefined) ?? DEFAULTS.darkThemePalette;
    let terminalThemeName = (entries.terminalThemeName as string | undefined) ?? DEFAULTS.terminalThemeName;
    const terminalThemeMode =
      storedTerminalThemeMode ??
      (terminalThemeName !== "auto" ? "independent" : "follow-app");
    if (terminalThemeMode === "independent" && terminalThemeName === "auto") {
      terminalThemeName = resolveAutoTerminalThemeId(resolvedTheme, lightThemePalette, darkThemePalette);
    }
    entries.terminalThemeName = terminalThemeName;
    entries.terminalThemeMode = terminalThemeMode;
    if (entries.keyboardShortcuts) {
      entries.keyboardShortcuts = { ...DEFAULTS.keyboardShortcuts, ...entries.keyboardShortcuts };
    }
    set({ ...entries, resolvedTheme, loaded: true });
    void applyDebugMode(debugMode);

    // Listen for system theme changes
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      const current = get().theme;
      if (current === "system") {
        set({ resolvedTheme: getSystemTheme() });
      }
    });
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
}));
