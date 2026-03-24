import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";

export type ThemeMode = "dark" | "light" | "system";
export type ShortcutAction = "newTerminal" | "closeTerminal" | "nextTab" | "prevTab" | "commandPalette";
export type KeyboardShortcutMap = Record<ShortcutAction, string>;

interface Settings {
  theme: ThemeMode;
  fontSize: number;
  fontFamily: string;
  defaultShell: string;
  sidebarWidth: number;
  historySidebarWidth: number;
  useExternalTerminal: boolean;
  debugMode: boolean;
  terminalThemeName: string;
  keyboardShortcuts: KeyboardShortcutMap;
}

interface SettingsStore extends Settings {
  resolvedTheme: "dark" | "light";
  loaded: boolean;
  load: () => Promise<void>;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
  setTheme: (mode: ThemeMode) => Promise<void>;
}

const DEFAULTS: Settings = {
  theme: "system",
  fontSize: 14,
  fontFamily: "Cascadia Code, Consolas, monospace",
  defaultShell: "powershell.exe",
  sidebarWidth: 280,
  historySidebarWidth: 300,
  useExternalTerminal: false,
  debugMode: false,
  terminalThemeName: "auto",
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
    if (entries.keyboardShortcuts) {
      entries.keyboardShortcuts = { ...DEFAULTS.keyboardShortcuts, ...entries.keyboardShortcuts };
    }
    set({ ...entries, resolvedTheme: resolveTheme(theme), loaded: true });
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
}));
