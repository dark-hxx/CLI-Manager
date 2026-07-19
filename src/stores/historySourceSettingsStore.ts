import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import { getCliManagerDataPaths } from "../lib/appPaths";
import { useSettingsStore } from "./settingsStore";
import {
  HISTORY_SOURCE_DESCRIPTOR_BY_ID,
  createHistorySourceInstanceId,
  inferHistorySourceEnvironment,
  type HistorySourceId,
  type HistorySourceInstanceSettings,
  type HistorySourceSettings,
  type HistorySourceSettingsMap,
} from "../lib/historySources";

type HistoryIndexStorageKind = "file" | "database" | "mixed";

interface HistorySourceSettingsStore {
  loaded: boolean;
  settings: HistorySourceSettingsMap;
  load: () => Promise<void>;
  setSourceSettings: (sourceId: HistorySourceId, settings: HistorySourceSettings) => Promise<void>;
  clearSource: (sourceId: HistorySourceId) => Promise<void>;
  syncHookConfigRoot: (sourceId: "claude" | "codex", path: string | null) => Promise<void>;
}

let store: Store | null = null;

async function getStore() {
  if (!store) {
    const paths = await getCliManagerDataPaths();
    store = await Store.load(paths.settingsStorePath, { autoSave: 0, defaults: {} });
  }
  return store;
}

function isSourceId(value: string): value is HistorySourceId {
  return [
    "claude",
    "codex",
    "gemini",
    "copilot",
    "antigravity",
    "grok",
    "pi",
    "opencode",
    "kiro",
    "cursor",
    "cline",
  ].includes(value);
}

function normalizeInstance(value: unknown): HistorySourceInstanceSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<HistorySourceInstanceSettings>;
  if (typeof raw.id !== "string" || !raw.id.trim()) return undefined;
  if (typeof raw.locations !== "object" || raw.locations === null || Array.isArray(raw.locations)) return undefined;
  const locations: Record<string, string> = {};
  for (const [slotId, path] of Object.entries(raw.locations)) {
    if (typeof path === "string" && path.trim()) {
      locations[slotId] = path.trim();
    }
  }
  if (Object.keys(locations).length === 0) return undefined;
  const firstPath = Object.values(locations)[0] ?? "";
  return {
    id: raw.id,
    environment: raw.environment ?? inferHistorySourceEnvironment(firstPath),
    locations,
  };
}

function normalizeSettingsMap(value: unknown): HistorySourceSettingsMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: HistorySourceSettingsMap = {};
  for (const [sourceId, rawSettings] of Object.entries(value)) {
    if (!isSourceId(sourceId) || typeof rawSettings !== "object" || rawSettings === null) continue;
    const raw = rawSettings as Partial<HistorySourceSettings>;
    const activeInstance = normalizeInstance(raw.activeInstance);
    result[sourceId] = {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : Boolean(activeInstance),
      ...(activeInstance ? { activeInstance } : {}),
    };
  }
  return result;
}

function instanceFromLegacyPath(sourceId: HistorySourceId, path: string | null | undefined): HistorySourceInstanceSettings | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  return {
    id: createHistorySourceInstanceId(sourceId),
    environment: inferHistorySourceEnvironment(trimmed),
    locations: { configRoot: trimmed },
  };
}

async function loadSettingsWithLegacyMigration(s: Store): Promise<HistorySourceSettingsMap> {
  const stored = normalizeSettingsMap(await s.get("historySourceSettings"));
  const claudeLegacy = instanceFromLegacyPath("claude", await s.get<string>("claudeHookConfigDir"));
  const codexLegacy = instanceFromLegacyPath("codex", await s.get<string>("codexHookConfigDir"));
  let changed = false;
  if (claudeLegacy && stored.claude?.activeInstance?.locations.configRoot !== claudeLegacy.locations.configRoot) {
    stored.claude = { enabled: stored.claude?.enabled ?? true, activeInstance: claudeLegacy };
    changed = true;
  }
  if (codexLegacy && stored.codex?.activeInstance?.locations.configRoot !== codexLegacy.locations.configRoot) {
    stored.codex = { enabled: stored.codex?.enabled ?? true, activeInstance: codexLegacy };
    changed = true;
  }
  if (changed) {
    await s.set("historySourceSettings", stored);
  }
  return stored;
}

function storageKindForSource(sourceId: HistorySourceId): HistoryIndexStorageKind {
  const descriptor = HISTORY_SOURCE_DESCRIPTOR_BY_ID.get(sourceId);
  const locationKind = descriptor?.locations[0]?.kind;
  if (sourceId === "cursor") return "mixed";
  if (locationKind === "database") return "database";
  return "file";
}

function environmentParts(instance: HistorySourceInstanceSettings): { environmentKind: string; environmentKey: string } {
  if (instance.environment.kind === "wsl") {
    return { environmentKind: "wsl", environmentKey: instance.environment.distro };
  }
  return { environmentKind: instance.environment.kind, environmentKey: instance.environment.kind };
}

function stableSettingsHash(sourceId: HistorySourceId, sourceSettings: HistorySourceSettings): string {
  return JSON.stringify({
    sourceId,
    enabled: sourceSettings.enabled,
    activeInstance: sourceSettings.activeInstance ?? null,
  });
}

function hookSettingKey(sourceId: "claude" | "codex"): "claudeHookConfigDir" | "codexHookConfigDir" {
  return sourceId === "claude" ? "claudeHookConfigDir" : "codexHookConfigDir";
}

function normalizedConfigRoot(sourceSettings: HistorySourceSettings | undefined): string | null {
  return sourceSettings?.activeInstance?.locations.configRoot?.trim() || null;
}

async function syncIndexSourceInstance(sourceId: HistorySourceId, sourceSettings: HistorySourceSettings): Promise<void> {
  const activeInstance = sourceSettings.activeInstance;
  if (!sourceSettings.enabled || !activeInstance) {
    await invoke("history_index_v2_deactivate_source_instance", { sourceId, instanceId: activeInstance?.id ?? null });
    return;
  }
  const { environmentKind, environmentKey } = environmentParts(activeInstance);
  await invoke("history_index_v2_upsert_source_instance", {
    input: {
      sourceId,
      instanceId: activeInstance.id,
      environmentKind,
      environmentKey,
      storageKind: storageKindForSource(sourceId),
      displayName: HISTORY_SOURCE_DESCRIPTOR_BY_ID.get(sourceId)?.defaultLabel ?? sourceId,
      locationsJson: JSON.stringify(activeInstance.locations),
      settingsHash: stableSettingsHash(sourceId, sourceSettings),
      discovered: false,
    },
  });
}

async function syncIndexSourceInstanceBestEffort(sourceId: HistorySourceId, sourceSettings: HistorySourceSettings): Promise<void> {
  try {
    await syncIndexSourceInstance(sourceId, sourceSettings);
  } catch (error) {
    console.warn("history source index snapshot sync failed", sourceId, error);
  }
}

export const useHistorySourceSettingsStore = create<HistorySourceSettingsStore>((set, get) => ({
  loaded: false,
  settings: {},

  load: async () => {
    const s = await getStore();
    const settings = await loadSettingsWithLegacyMigration(s);
    set({ settings, loaded: true });
    for (const [sourceId, sourceSettings] of Object.entries(settings)) {
      if (isSourceId(sourceId) && sourceSettings) {
        void syncIndexSourceInstanceBestEffort(sourceId, sourceSettings);
      }
    }
    for (const sourceId of ["claude", "codex"] as const) {
      const configRoot = normalizedConfigRoot(settings[sourceId]);
      const key = hookSettingKey(sourceId);
      if (configRoot && useSettingsStore.getState()[key]?.trim() !== configRoot) {
        await useSettingsStore.getState().update(key, configRoot);
      }
    }
  },

  setSourceSettings: async (sourceId, sourceSettings) => {
    const s = await getStore();
    const next = {
      ...get().settings,
      [sourceId]: sourceSettings,
    };
    await s.set("historySourceSettings", next);
    set({ settings: next });
    void syncIndexSourceInstanceBestEffort(sourceId, sourceSettings);
    if (sourceId === "claude" || sourceId === "codex") {
      const configRoot = normalizedConfigRoot(sourceSettings);
      const key = hookSettingKey(sourceId);
      if (configRoot && useSettingsStore.getState()[key]?.trim() !== configRoot) {
        await useSettingsStore.getState().update(key, configRoot);
      }
    }
  },

  clearSource: async (sourceId) => {
    const s = await getStore();
    const next = { ...get().settings };
    delete next[sourceId];
    await s.set("historySourceSettings", next);
    set({ settings: next });
    void syncIndexSourceInstanceBestEffort(sourceId, { enabled: false });
    if (sourceId === "claude" || sourceId === "codex") {
      const key = hookSettingKey(sourceId);
      if (useSettingsStore.getState()[key] !== null) {
        await useSettingsStore.getState().update(key, null);
      }
    }
  },

  syncHookConfigRoot: async (sourceId, path) => {
    if (!get().loaded) await get().load();
    const normalizedPath = path?.trim() || null;
    const current = get().settings[sourceId];
    if (normalizedConfigRoot(current) === normalizedPath) return;
    const nextSourceSettings: HistorySourceSettings = normalizedPath
      ? {
          enabled: current?.enabled ?? true,
          activeInstance: instanceFromLegacyPath(sourceId, normalizedPath),
        }
      : { enabled: current?.enabled ?? true };
    const next = { ...get().settings, [sourceId]: nextSourceSettings };
    const s = await getStore();
    await s.set("historySourceSettings", next);
    set({ settings: next });
    void syncIndexSourceInstanceBestEffort(sourceId, nextSourceSettings);
  },
}));

useSettingsStore.subscribe((state, previous) => {
  if (state.claudeHookConfigDir !== previous.claudeHookConfigDir) {
    void useHistorySourceSettingsStore
      .getState()
      .syncHookConfigRoot("claude", state.claudeHookConfigDir);
  }
  if (state.codexHookConfigDir !== previous.codexHookConfigDir) {
    void useHistorySourceSettingsStore
      .getState()
      .syncHookConfigRoot("codex", state.codexHookConfigDir);
  }
});
