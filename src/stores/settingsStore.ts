import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";

export type ThemeMode = "dark" | "light" | "system";

interface Settings {
  theme: ThemeMode;
  fontSize: number;
  fontFamily: string;
  defaultShell: string;
  sidebarWidth: number;
  useExternalTerminal: boolean;
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
  useExternalTerminal: false,
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
    set({ ...entries, resolvedTheme: resolveTheme(theme), loaded: true });

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
  },

  setTheme: async (mode) => {
    const s = await getStore();
    await s.set("theme", mode);
    set({ theme: mode, resolvedTheme: resolveTheme(mode) });
  },
}));
