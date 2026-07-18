import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { getDb, batchInsert } from "../lib/db";
import { getCliManagerDataPaths } from "../lib/appPaths";
import { singleFlight } from "../lib/singleFlight";
import { useProjectStore } from "./projectStore";
import { useSettingsStore, type Settings } from "./settingsStore";
import { useModelPricingStore } from "./modelPricingStore";
import { useWorktreeStore } from "./worktreeStore";
import { logInfo } from "../lib/logger";
import { defaultShellForOs, getOsPlatform, isWindowsOnlyShellKey, normalizeShellForOs } from "../lib/shell";
import { sanitizeThirdPartyHookTargets } from "../lib/thirdPartyNotifications";
import {
  pickSyncableSettings,
  SYNCABLE_SETTING_KEYS,
  type SyncableSettingKey,
} from "../lib/syncSettings";

export type SyncStatus = "idle" | "syncing" | "success" | "error" | "conflict";
export type SyncMode = "cloud" | "local";
export type AutoSyncAction = "off" | "upload" | "download";
export type SyncDataDomain =
  | "projects"
  | "groups"
  | "command_templates"
  | "application_settings"
  | "model_prices"
  | "third_party_hook_notifications";

interface SyncMeta {
  device_id: string;
  last_sync_at: string | null;
}

interface ConflictInfo {
  local_modified: string;
  remote_modified: string;
  local_projects: number;
  remote_projects: number;
  local_groups: number;
  remote_groups: number;
  local_templates: number;
  remote_templates: number;
}

interface SyncPayload {
  projects: Record<string, unknown>[];
  groups: Record<string, unknown>[];
  command_templates: Record<string, unknown>[];
  worktrees: Record<string, unknown>[];
  model_prices?: Record<string, unknown>[];
  settings: Record<string, unknown>;
}

interface SyncData {
  version: number;
  device_id: string;
  device_name: string;
  last_modified: string;
  data: SyncPayload;
}

export interface SyncSnapshotSummary {
  deviceName: string;
  lastModified: string;
  projects: number;
  groups: number;
  commandTemplates: number;
  applicationSettings: number;
  modelPrices: number;
  thirdPartyHookTargets: number;
  projectNames: string[];
  groupNames: string[];
  templateNames: string[];
  missing?: boolean;
}

export interface SyncPreview {
  local: SyncSnapshotSummary;
  remote: SyncSnapshotSummary;
}

export interface DeviceSnapshotInfo {
  device_name: string;
  last_modified: string;
  projects: number;
  groups: number;
  command_templates: number;
}

interface SyncStore {
  webdavUrl: string;
  webdavUsername: string;
  hasPassword: boolean;
  status: SyncStatus;
  lastSyncAt: string | null;
  deviceId: string;
  deviceName: string;
  knownDeviceNames: string[];
  autoSyncOnStartup: AutoSyncAction;
  autoSyncOnClose: AutoSyncAction;
  conflictInfo: ConflictInfo | null;
  pendingRemoteData: SyncData | null;
  loaded: boolean;
  syncMode: SyncMode;
  localSyncDir: string;
  remoteDir: string;

  load: () => Promise<void>;
  setConfig: (url: string, username: string, password?: string) => Promise<void>;
  clearPassword: () => Promise<void>;
  getSessionPassword: () => string;
  testConnection: (url: string, username: string, password: string) => Promise<{ success: boolean; message: string }>;
  setDeviceName: (name: string) => Promise<void>;
  setAutoSyncOnStartup: (action: AutoSyncAction) => Promise<void>;
  setAutoSyncOnClose: (action: AutoSyncAction) => Promise<void>;
  upload: () => Promise<void>;
  download: (force?: boolean, options?: { deviceName?: string; domains?: SyncDataDomain[] }) => Promise<void>;
  getPreview: (deviceName?: string) => Promise<SyncPreview>;
  listDeviceSnapshots: () => Promise<DeviceSnapshotInfo[]>;
  runAutoSync: (phase: "startup" | "close") => Promise<"skipped" | "success" | "conflict" | "error">;
  resolveConflict: (keepLocal: boolean) => Promise<void>;
  clearConflict: () => void;
  setSyncMode: (mode: SyncMode) => Promise<void>;
  setLocalSyncDir: (dir: string) => Promise<void>;
  setRemoteDir: (dir: string) => Promise<void>;
  localExport: () => Promise<string>;
  localImport: (zipPath: string) => Promise<void>;
}

let store: Store | null = null;
let sessionWebdavPassword = "";
async function getStore() {
  if (!store) {
    const paths = await getCliManagerDataPaths();
    store = await Store.load(paths.syncStorePath, { autoSave: 0, defaults: {} });
  }
  return store;
}

const SYNC_DATA_VERSION = 2;
const AUTO_SYNC_ACTIONS: readonly AutoSyncAction[] = ["off", "upload", "download"];
const SYNC_DATA_DOMAINS: readonly SyncDataDomain[] = [
  "projects",
  "groups",
  "command_templates",
  "application_settings",
  "model_prices",
  "third_party_hook_notifications",
];
const HTTP_NOT_FOUND_PATTERN = /HTTP error:\s*(404|409)\b/i;
const REMOTE_SYNC_UNAVAILABLE_MESSAGE = "无法从云端同步";
const PROJECT_SYNC_SELECT =
  "SELECT id, name, path, group_id, sort_order, cli_tool, cli_args, startup_cmd, env_vars, shell, provider_overrides, worktree_strategy, worktree_root, worktree_deps_prompt_enabled FROM projects ORDER BY sort_order";
const GROUP_SYNC_SELECT = "SELECT id, name, parent_id, sort_order FROM groups ORDER BY sort_order";
const TEMPLATE_SYNC_SELECT = "SELECT id, project_id, name, command, description, sort_order FROM command_templates ORDER BY sort_order";
const WORKTREE_SYNC_SELECT =
  "SELECT id, project_id, name, branch, path, base_branch, deps_prompt_dismissed, provider_overrides, status, created_at, updated_at FROM worktrees WHERE status = 'active' ORDER BY created_at DESC";
const MODEL_PRICE_SYNC_COLUMNS = [
  "model",
  "input_per_1m",
  "output_per_1m",
  "cache_read_per_1m",
  "cache_creation_per_1m",
  "source",
  "source_model_id",
  "raw_json",
  "updated_at_ms",
  "synced_at_ms",
] as const;
const MODEL_PRICE_SYNC_SELECT = `SELECT ${MODEL_PRICE_SYNC_COLUMNS.join(", ")} FROM model_prices ORDER BY model COLLATE NOCASE`;

interface SyncDownloadCommandResult {
  success: boolean;
  has_conflict: boolean;
  conflict_info: ConflictInfo | null;
  data: SyncData | null;
}

function migrateAutoSyncAction(value: unknown): AutoSyncAction {
  return AUTO_SYNC_ACTIONS.includes(value as AutoSyncAction) ? (value as AutoSyncAction) : "off";
}

function sanitizeDeviceName(value: string): string {
  return value
    .trim()
    .replace(/[ .]+/g, "-")
    .replace(/[^\p{Script=Han}A-Za-z0-9_-]/gu, "")
    .slice(0, 64);
}

function uniqueDeviceNames(names: string[]): string[] {
  const result: string[] = [];
  for (const name of names) {
    const trimmed = sanitizeDeviceName(name);
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  }
  return result;
}

function normalizeDomains(domains?: SyncDataDomain[]): SyncDataDomain[] {
  if (!domains || domains.length === 0) return [...SYNC_DATA_DOMAINS];
  return SYNC_DATA_DOMAINS.filter((domain) => domains.includes(domain));
}

function isHttpNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return HTTP_NOT_FOUND_PATTERN.test(message);
}

function downloadRemoteSnapshot(
  webdavUrl: string,
  webdavUsername: string,
  password: string,
  localData: SyncData,
  force: boolean,
  deviceName: string,
  remoteDir: string,
): Promise<SyncDownloadCommandResult> {
  return invoke<SyncDownloadCommandResult>("sync_download", {
    config: { url: webdavUrl, username: webdavUsername, password },
    localData,
    force,
    deviceName,
    remoteDir,
  });
}

function isConfigured(state: Pick<SyncStore, "syncMode" | "webdavUrl" | "hasPassword">): boolean {
  return state.syncMode === "cloud" && Boolean(state.webdavUrl.trim()) && state.hasPassword;
}

function normalizeWorktreeStrategy(value: unknown): string {
  return value === "prompt" || value === "autoParallel" || value === "always" ? value : "disabled";
}

function normalizeWorktreeStatus(value: unknown): string {
  return value === "missing" ? "missing" : "active";
}

function toInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function asSyncSettings(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeSyncedModelPrices(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const result: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const model = typeof row.model === "string" ? row.model.trim() : "";
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push({
      model,
      input_per_1m: finiteNonNegative(row.input_per_1m),
      output_per_1m: finiteNonNegative(row.output_per_1m),
      cache_read_per_1m: finiteNonNegative(row.cache_read_per_1m),
      cache_creation_per_1m: finiteNonNegative(row.cache_creation_per_1m),
      source: typeof row.source === "string" && row.source.trim() ? row.source.trim() : "manual",
      source_model_id: nullableText(row.source_model_id),
      raw_json: nullableText(row.raw_json),
      updated_at_ms: toInteger(row.updated_at_ms, 0),
      synced_at_ms: row.synced_at_ms === null || row.synced_at_ms === undefined
        ? null
        : toInteger(row.synced_at_ms, 0),
    });
  }
  return result;
}

async function updateSyncedSetting<K extends SyncableSettingKey>(key: K, value: Settings[K]) {
  await useSettingsStore.getState().update(key, value);
}

async function applySyncedApplicationSettings(value: unknown): Promise<SyncableSettingKey[]> {
  const settings = pickSyncableSettings(asSyncSettings(value));
  const applied: SyncableSettingKey[] = [];
  for (const key of SYNCABLE_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    await updateSyncedSetting(key, settings[key] as Settings[typeof key]);
    applied.push(key);
  }
  if (applied.length > 0) {
    await useSettingsStore.getState().load();
  }
  return applied;
}

async function refreshSyncedStores() {
  await useWorktreeStore.getState().loadWorktrees();
  await useWorktreeStore.getState().markMissingWorktrees();
  await useProjectStore.getState().fetchAll();
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  webdavUrl: "",
  webdavUsername: "",
  hasPassword: false,
  status: "idle",
  lastSyncAt: null,
  deviceId: "",
  deviceName: "",
  knownDeviceNames: [],
  autoSyncOnStartup: "off",
  autoSyncOnClose: "off",
  conflictInfo: null,
  pendingRemoteData: null,
  loaded: false,
  syncMode: "cloud",
  localSyncDir: "",
  remoteDir: "",

  load: singleFlight(async () => {
    const s = await getStore();
    const url = (await s.get<string>("webdavUrl")) ?? "";
    const username = (await s.get<string>("webdavUsername")) ?? "";
    await s.delete("webdavPassword").catch(() => false);
    await s.delete("hasPassword").catch(() => false);
    let password = "";
    try {
      password = (await invoke<string | null>("sync_load_password")) ?? "";
    } catch (error) {
      console.error("[sync] 读取 WebDAV 密码失败:", error);
    }
    sessionWebdavPassword = password;
    const hasPassword = password.length > 0;
    const syncMode = ((await s.get<string>("syncMode")) as SyncMode | undefined) ?? "cloud";
    const localSyncDir = (await s.get<string>("localSyncDir")) ?? "";
    const remoteDir = (await s.get<string>("remoteDir")) ?? "";
    const autoSyncOnStartup = migrateAutoSyncAction(await s.get("autoSyncOnStartup"));
    const autoSyncOnClose = migrateAutoSyncAction(await s.get("autoSyncOnClose"));
    const storedKnownDeviceNames = (await s.get<string[]>("knownDeviceNames")) ?? [];
    let deviceName = (await s.get<string>("deviceName"))?.trim() ?? "";
    if (!deviceName) {
      try {
        const result = await invoke<{ device_name: string }>("sync_get_default_device_name");
        deviceName = sanitizeDeviceName(result.device_name);
      } catch {
        deviceName = "当前设备";
      }
      await s.set("deviceName", deviceName);
    }
    const knownDeviceNames = uniqueDeviceNames([deviceName, ...storedKnownDeviceNames]);
    await s.set("knownDeviceNames", knownDeviceNames);
    await s.set("autoSyncOnStartup", autoSyncOnStartup);
    await s.set("autoSyncOnClose", autoSyncOnClose);

    const db = await getDb();
    const meta = await db.select<SyncMeta[]>(
      "SELECT device_id, last_sync_at FROM sync_meta WHERE id = 'singleton'"
    );

    const deviceId = meta[0]?.device_id ?? crypto.randomUUID();
    const lastSyncAt = meta[0]?.last_sync_at ?? null;

    set({
      webdavUrl: url,
      webdavUsername: username,
      hasPassword,
      deviceId,
      deviceName,
      knownDeviceNames,
      lastSyncAt,
      syncMode,
      localSyncDir,
      remoteDir,
      autoSyncOnStartup,
      autoSyncOnClose,
      loaded: true,
    });
  }),

  setConfig: async (url, username, password) => {
    const s = await getStore();
    await s.set("webdavUrl", url);
    await s.set("webdavUsername", username);
    if (password !== undefined) {
      const hasPassword = password.length > 0;
      if (hasPassword) {
        await invoke("sync_save_password", { password });
      } else {
        await invoke("sync_delete_password");
      }
      sessionWebdavPassword = password;
      await s.delete("webdavPassword").catch(() => false);
      set({ webdavUrl: url, webdavUsername: username, hasPassword });
    } else {
      // Preserve existing hasPassword state when not providing new password
      set({ webdavUrl: url, webdavUsername: username });
    }
  },

  clearPassword: async () => {
    const s = await getStore();
    await invoke("sync_delete_password");
    await s.delete("webdavPassword").catch(() => false);
    sessionWebdavPassword = "";
    set({ hasPassword: false });
  },

  getSessionPassword: () => sessionWebdavPassword,

  testConnection: async (url, username, password) => {
    const result = await invoke<{ success: boolean; message: string }>("sync_test_connection", {
      config: { url, username, password },
    });
    return result;
  },

  setDeviceName: async (name) => {
    const deviceName = sanitizeDeviceName(name);
    if (!deviceName) {
      throw new Error("设备名称不能为空");
    }
    const s = await getStore();
    const knownDeviceNames = uniqueDeviceNames([deviceName, ...get().knownDeviceNames]);
    await s.set("deviceName", deviceName);
    await s.set("knownDeviceNames", knownDeviceNames);
    set({ deviceName, knownDeviceNames });
  },

  setAutoSyncOnStartup: async (action) => {
    const next = migrateAutoSyncAction(action);
    const s = await getStore();
    await s.set("autoSyncOnStartup", next);
    set({ autoSyncOnStartup: next });
  },

  setAutoSyncOnClose: async (action) => {
    const next = migrateAutoSyncAction(action);
    const s = await getStore();
    await s.set("autoSyncOnClose", next);
    set({ autoSyncOnClose: next });
  },

  upload: async () => {
    const { webdavUrl, webdavUsername, deviceId, deviceName, remoteDir } = get();
    const password = sessionWebdavPassword;

    if (!webdavUrl || !password) {
      set({ status: "error" });
      return;
    }

    set({ status: "syncing" });

    try {
      const db = await getDb();
      const syncData = await collectLocalSyncData(db, deviceId, deviceName, new Date().toISOString());

      await invoke("sync_upload", {
        config: { url: webdavUrl, username: webdavUsername, password },
        data: syncData,
        remoteDir: remoteDir || undefined,
      });

      await db.execute(
        "INSERT OR REPLACE INTO sync_meta (id, device_id, last_sync_at, remote_version) VALUES ('singleton', ?, ?, ?)",
        [deviceId, syncData.last_modified, syncData.last_modified]
      );

      set({
        status: "success",
        lastSyncAt: syncData.last_modified,
        conflictInfo: null,
        pendingRemoteData: null,
      });
    } catch (error) {
      console.error("Upload failed:", error);
      set({ status: "error" });
      throw error; // Re-throw to let UI show the error
    }
  },

  download: async (force = false, options) => {
    const { webdavUrl, webdavUsername, deviceId, deviceName, remoteDir } = get();
    const password = sessionWebdavPassword;

    if (!webdavUrl || !password) {
      set({ status: "error" });
      return;
    }

    set({ status: "syncing" });

    try {
      const db = await getDb();
      const localData = await collectLocalSyncData(db, deviceId, deviceName, get().lastSyncAt ?? new Date(0).toISOString());

      const result = await downloadRemoteSnapshot(
        webdavUrl,
        webdavUsername,
        password,
        localData,
        force,
        options?.deviceName ?? deviceName,
        remoteDir,
      );

      if (!result.data) {
        set({ status: "error" });
        throw new Error(REMOTE_SYNC_UNAVAILABLE_MESSAGE);
      }

      if (result.has_conflict && result.conflict_info) {
        set({
          status: "conflict",
          conflictInfo: result.conflict_info,
          pendingRemoteData: result.data,
        });
        return;
      }

      await applySyncData(db, result.data, deviceId, options?.domains);
      await refreshSyncedStores();
      set({
        status: "success",
        lastSyncAt: result.data.last_modified,
        conflictInfo: null,
        pendingRemoteData: null,
      });
    } catch (error) {
      console.error("Download failed:", error);
      set({ status: "error" });
      throw error;
    }
  },

  getPreview: async (targetDeviceName) => {
    const { webdavUrl, webdavUsername, deviceId, deviceName, remoteDir } = get();
    const password = sessionWebdavPassword;
    if (!webdavUrl || !password) {
      throw new Error("请先配置并测试 WebDAV 连接");
    }
    const db = await getDb();
    const localData = await collectLocalSyncData(db, deviceId, deviceName, get().lastSyncAt ?? new Date(0).toISOString());
    let remoteSummary: SyncSnapshotSummary;
    try {
      const previewResult = await downloadRemoteSnapshot(
        webdavUrl,
        webdavUsername,
        password,
        localData,
        true,
        targetDeviceName ?? deviceName,
        remoteDir,
      );
      if (previewResult.data) {
        const remoteData = previewResult.data;
        remoteSummary = summarizeSyncData(remoteData, targetDeviceName ?? remoteData.device_name ?? deviceName);
      } else {
        remoteSummary = createMissingRemoteSummary(targetDeviceName ?? deviceName);
      }
    } catch (error) {
      if (!isHttpNotFoundError(error)) {
        throw error;
      }
      remoteSummary = createMissingRemoteSummary(targetDeviceName ?? deviceName);
    }
    return {
      local: summarizeSyncData(localData, deviceName),
      remote: remoteSummary,
    };
  },

  listDeviceSnapshots: async () => {
    const { webdavUrl, webdavUsername, knownDeviceNames, remoteDir } = get();
    const password = sessionWebdavPassword;
    if (!webdavUrl || !password) return [];
    return invoke<DeviceSnapshotInfo[]>("sync_list_device_snapshots", {
      config: { url: webdavUrl, username: webdavUsername, password },
      deviceNames: knownDeviceNames,
      remoteDir: remoteDir || undefined,
    });
  },

  runAutoSync: async (phase) => {
    const state = get();
    const action = phase === "startup" ? state.autoSyncOnStartup : state.autoSyncOnClose;
    if (action === "off" || !isConfigured(state)) return "skipped";
    try {
      if (action === "upload") {
        await get().upload();
      } else {
        await get().download(false, { deviceName: state.deviceName });
      }
      return get().status === "conflict" ? "conflict" : "success";
    } catch {
      return "error";
    }
  },

  resolveConflict: async (keepLocal) => {
    const { pendingRemoteData, deviceId } = get();

    if (keepLocal) {
      await get().upload();
    } else if (pendingRemoteData) {
      const db = await getDb();
      await applySyncData(db, pendingRemoteData, deviceId);
      await refreshSyncedStores();
      await get().upload();
    }
  },

  clearConflict: () => {
    set({ status: "idle", conflictInfo: null, pendingRemoteData: null });
  },

  setSyncMode: async (mode) => {
    const s = await getStore();
    await s.set("syncMode", mode);
    set({ syncMode: mode });
  },

  setLocalSyncDir: async (dir) => {
    const s = await getStore();
    await s.set("localSyncDir", dir);
    set({ localSyncDir: dir });
  },

  setRemoteDir: async (dir) => {
    const s = await getStore();
    await s.set("remoteDir", dir);
    set({ remoteDir: dir });
  },

  localExport: async () => {
    const { localSyncDir, deviceId, deviceName } = get();
    if (!localSyncDir) {
      throw new Error("请先选择本地同步目录");
    }
    set({ status: "syncing" });
    try {
      const db = await getDb();

      const now = new Date().toISOString();
      const syncData = await collectLocalSyncData(db, deviceId, deviceName, now);

      const result = await invoke<{ success: boolean; path: string; message: string }>(
        "sync_local_export",
        { dir: localSyncDir, data: syncData }
      );

      await db.execute(
        "INSERT OR REPLACE INTO sync_meta (id, device_id, last_sync_at, remote_version) VALUES ('singleton', ?, ?, ?)",
        [deviceId, now, now]
      );

      set({ status: "success", lastSyncAt: now });
      return result.path;
    } catch (error) {
      console.error("Local export failed:", error);
      set({ status: "error" });
      throw error;
    }
  },

  localImport: async (zipPath) => {
    const { deviceId } = get();
    set({ status: "syncing" });
    try {
      const data = await invoke<SyncData>("sync_local_import", { zipPath });
      const db = await getDb();
      await applySyncData(db, data, deviceId);
      await refreshSyncedStores();
      set({
        status: "success",
        lastSyncAt: data.last_modified,
        conflictInfo: null,
        pendingRemoteData: null,
      });
    } catch (error) {
      console.error("Local import failed:", error);
      set({ status: "error" });
      throw error;
    }
  },
}));

async function collectLocalSyncData(
  db: Awaited<ReturnType<typeof getDb>>,
  deviceId: string,
  deviceName: string,
  lastModified: string,
): Promise<SyncData> {
  const projects = await db.select<Record<string, unknown>[]>(PROJECT_SYNC_SELECT);
  const groups = await db.select<Record<string, unknown>[]>(GROUP_SYNC_SELECT);
  const commandTemplates = await db.select<Record<string, unknown>[]>(TEMPLATE_SYNC_SELECT);
  const worktrees = await db.select<Record<string, unknown>[]>(WORKTREE_SYNC_SELECT);
  const modelPrices = await db.select<Record<string, unknown>[]>(MODEL_PRICE_SYNC_SELECT);
  const settings = useSettingsStore.getState();
  const portableSettings = pickSyncableSettings(settings as unknown as Record<string, unknown>);
  return {
    version: SYNC_DATA_VERSION,
    device_id: deviceId,
    device_name: deviceName,
    last_modified: lastModified,
    data: {
      projects,
      groups,
      command_templates: commandTemplates,
      worktrees,
      model_prices: modelPrices,
      settings: {
        ...portableSettings,
        thirdPartyHookNotificationsEnabled: settings.thirdPartyHookNotificationsEnabled,
        thirdPartyHookTargets: sanitizeThirdPartyHookTargets(settings.thirdPartyHookTargets),
      },
    },
  };
}

function summarizeSyncData(data: SyncData, fallbackDeviceName: string): SyncSnapshotSummary {
  const settings = asSyncSettings(data.data.settings);
  const supportsExtendedData = data.version >= 2;
  return {
    deviceName: data.device_name?.trim() || fallbackDeviceName,
    lastModified: data.last_modified,
    projects: data.data.projects.length,
    groups: data.data.groups.length,
    commandTemplates: data.data.command_templates.length,
    applicationSettings: supportsExtendedData ? Object.keys(pickSyncableSettings(settings)).length : 0,
    modelPrices: supportsExtendedData ? normalizeSyncedModelPrices(data.data.model_prices).length : 0,
    thirdPartyHookTargets: sanitizeThirdPartyHookTargets(settings.thirdPartyHookTargets).length,
    projectNames: data.data.projects.slice(0, 5).map((item) => String(item.name ?? "未命名项目")),
    groupNames: data.data.groups.slice(0, 5).map((item) => String(item.name ?? "未命名分组")),
    templateNames: data.data.command_templates.slice(0, 5).map((item) => String(item.name ?? "未命名模板")),
  };
}

function createMissingRemoteSummary(deviceName: string): SyncSnapshotSummary {
  return {
    deviceName,
    lastModified: "",
    projects: 0,
    groups: 0,
    commandTemplates: 0,
    applicationSettings: 0,
    modelPrices: 0,
    thirdPartyHookTargets: 0,
    projectNames: [],
    groupNames: [],
    templateNames: [],
    missing: true,
  };
}

async function applySyncData(
  db: Awaited<ReturnType<typeof getDb>>,
  data: SyncData,
  deviceId: string,
  domains?: SyncDataDomain[],
) {
  const selectedDomains = normalizeDomains(domains);
  const shouldApplyGroups = selectedDomains.includes("groups");
  const shouldApplyProjects = selectedDomains.includes("projects");
  const shouldApplyTemplates = selectedDomains.includes("command_templates");
  const supportsExtendedData = data.version >= 2;
  const shouldApplyApplicationSettings =
    supportsExtendedData && selectedDomains.includes("application_settings");
  const shouldApplyModelPrices =
    supportsExtendedData &&
    selectedDomains.includes("model_prices") &&
    Array.isArray(data.data.model_prices);
  const shouldApplyThirdPartyHookNotifications = selectedDomains.includes("third_party_hook_notifications");
  const backupProjects = await db.select<Record<string, unknown>[]>("SELECT * FROM projects");
  const backupGroups = await db.select<Record<string, unknown>[]>("SELECT * FROM groups");
  const backupTemplates = await db.select<Record<string, unknown>[]>("SELECT * FROM command_templates");
  const backupWorktrees = await db.select<Record<string, unknown>[]>("SELECT * FROM worktrees");
  const backupModelPrices = shouldApplyModelPrices
    ? await db.select<Record<string, unknown>[]>(MODEL_PRICE_SYNC_SELECT)
    : [];
  const currentSettings = useSettingsStore.getState();
  const backupApplicationSettings = pickSyncableSettings(
    currentSettings as unknown as Record<string, unknown>,
  );
  const backupThirdPartyHookNotificationsEnabled = currentSettings.thirdPartyHookNotificationsEnabled;
  const backupThirdPartyHookTargets = currentSettings.thirdPartyHookTargets;
  const remoteSettings = asSyncSettings(data.data.settings);
  const hasRemoteThirdPartyHookNotificationsEnabled = Object.prototype.hasOwnProperty.call(
    remoteSettings,
    "thirdPartyHookNotificationsEnabled",
  );
  const hasRemoteThirdPartyHookTargets = Object.prototype.hasOwnProperty.call(
    remoteSettings,
    "thirdPartyHookTargets",
  );
  const shouldApplyThirdPartyHookTargets =
    shouldApplyThirdPartyHookNotifications && hasRemoteThirdPartyHookTargets;
  const remoteThirdPartyHookTargets = shouldApplyThirdPartyHookTargets
    ? sanitizeThirdPartyHookTargets(remoteSettings.thirdPartyHookTargets)
    : backupThirdPartyHookTargets;
  const appliedSettingsKeys: Array<
    "thirdPartyHookNotificationsEnabled" | "thirdPartyHookTargets"
  > = [];
  let appliedApplicationSettingKeys: SyncableSettingKey[] = [];
  const shouldApplyDatabaseData = shouldApplyTemplates || shouldApplyProjects || shouldApplyGroups;
  let databaseMutated = false;
  let modelPricesMutated = false;

  const nowStr = Date.now().toString();
  const os = await getOsPlatform();
  const platformDefaultShell = defaultShellForOs(os);

  const insertGroups = async (groups: Record<string, unknown>[]) => {
    await batchInsert(
      db,
      "groups",
      ["id", "name", "parent_id", "sort_order", "created_at"],
      groups,
      (group) => [
        group.id as string,
        group.name as string,
        (group.parent_id as string | null) ?? null,
        group.sort_order as number,
        (group.created_at as string) ?? nowStr,
      ],
    );
  };

  const insertProjects = async (projects: Record<string, unknown>[], validGroupIds: Set<string>) => {
    await batchInsert(
      db,
      "projects",
      [
        "id",
        "name",
        "path",
        "group_id",
        "sort_order",
        "cli_tool",
        "cli_args",
        "startup_cmd",
        "env_vars",
        "shell",
        "provider_overrides",
        "worktree_strategy",
        "worktree_root",
        "worktree_deps_prompt_enabled",
        "created_at",
        "updated_at",
      ],
      projects,
      (project) => {
        const groupId = typeof project.group_id === "string" && validGroupIds.has(project.group_id) ? project.group_id : null;
        const rawShell = typeof project.shell === "string" ? project.shell.trim() : "";
        const shell =
          normalizeShellForOs(rawShell, os) ??
          (rawShell && !(os !== "windows" && isWindowsOnlyShellKey(rawShell)) ? rawShell : platformDefaultShell);
        return [
          project.id as string,
          project.name as string,
          project.path as string,
          groupId,
          project.sort_order as number,
          (project.cli_tool as string) ?? "",
          (project.cli_args as string) ?? "",
          (project.startup_cmd as string) ?? "",
          (project.env_vars as string) ?? "{}",
          shell,
          (project.provider_overrides as string) ?? "{}",
          normalizeWorktreeStrategy(project.worktree_strategy),
          (project.worktree_root as string) ?? "",
          toInteger(project.worktree_deps_prompt_enabled, 0),
          (project.created_at as string) ?? nowStr,
          (project.updated_at as string) ?? nowStr,
        ];
      },
    );
  };

  const insertWorktrees = async (worktrees: Record<string, unknown>[], validProjectIds: Set<string>) => {
    const validWorktrees = worktrees.filter((worktree) => {
      return (
        typeof worktree.project_id === "string" &&
        validProjectIds.has(worktree.project_id) &&
        normalizeWorktreeStatus(worktree.status) === "active"
      );
    });
    await batchInsert(
      db,
      "worktrees",
      [
        "id",
        "project_id",
        "name",
        "branch",
        "path",
        "base_branch",
        "deps_prompt_dismissed",
        "provider_overrides",
        "status",
        "created_at",
        "updated_at",
      ],
      validWorktrees,
      (worktree) => [
        worktree.id as string,
        worktree.project_id as string,
        worktree.name as string,
        worktree.branch as string,
        worktree.path as string,
        (worktree.base_branch as string) ?? "",
        toInteger(worktree.deps_prompt_dismissed, 0),
        (worktree.provider_overrides as string) ?? "{}",
        normalizeWorktreeStatus(worktree.status),
        (worktree.created_at as string) ?? nowStr,
        (worktree.updated_at as string) ?? nowStr,
      ],
    );
  };

  const insertTemplates = async (templates: Record<string, unknown>[], validProjectIds: Set<string>) => {
    await batchInsert(
      db,
      "command_templates",
      ["id", "project_id", "name", "command", "description", "sort_order"],
      templates,
      (template) => {
        const projectId = typeof template.project_id === "string" && validProjectIds.has(template.project_id)
          ? template.project_id
          : null;
        return [
          template.id as string,
          projectId,
          template.name as string,
          template.command as string,
          (template.description as string) ?? "",
          template.sort_order as number,
        ];
      },
    );
  };

  const insertModelPrices = async (prices: Record<string, unknown>[]) => {
    const normalized = normalizeSyncedModelPrices(prices);
    await batchInsert(
      db,
      "model_prices",
      MODEL_PRICE_SYNC_COLUMNS,
      normalized,
      (price) => MODEL_PRICE_SYNC_COLUMNS.map((column) => price[column]),
    );
  };

  try {
    if (shouldApplyDatabaseData) {
      databaseMutated = true;
      await db.execute("DELETE FROM command_templates");
    }
    if (shouldApplyProjects || shouldApplyGroups) {
      await db.execute("DELETE FROM worktrees");
      await db.execute("DELETE FROM projects");
    }
    if (shouldApplyGroups) {
      await db.execute("DELETE FROM groups");
    }

    const finalGroups = shouldApplyGroups ? data.data.groups : backupGroups;
    const finalProjects = shouldApplyProjects ? data.data.projects : backupProjects;
    const finalTemplates = shouldApplyTemplates ? data.data.command_templates : backupTemplates;
    const finalWorktrees = shouldApplyProjects ? (data.data.worktrees ?? []) : backupWorktrees;
    const finalGroupIds = new Set(finalGroups.map((group) => String(group.id)));
    const finalProjectIds = new Set(finalProjects.map((project) => String(project.id)));

    if (shouldApplyGroups) {
      await insertGroups(finalGroups);
    }
    if (shouldApplyProjects || shouldApplyGroups) {
      await insertProjects(finalProjects, finalGroupIds);
      await insertWorktrees(finalWorktrees, finalProjectIds);
    }
    if (shouldApplyTemplates || shouldApplyProjects || shouldApplyGroups) {
      await insertTemplates(finalTemplates, finalProjectIds);
    }

    if (shouldApplyModelPrices) {
      modelPricesMutated = true;
      await db.execute("DELETE FROM model_prices");
      await insertModelPrices(data.data.model_prices ?? []);
    }

    if (shouldApplyApplicationSettings) {
      appliedApplicationSettingKeys = await applySyncedApplicationSettings(remoteSettings);
    }

    if (
      shouldApplyThirdPartyHookNotifications &&
      hasRemoteThirdPartyHookNotificationsEnabled &&
      typeof remoteSettings.thirdPartyHookNotificationsEnabled === "boolean"
    ) {
      await useSettingsStore.getState().update(
        "thirdPartyHookNotificationsEnabled",
        remoteSettings.thirdPartyHookNotificationsEnabled,
      );
      appliedSettingsKeys.push("thirdPartyHookNotificationsEnabled");
    }
    if (shouldApplyThirdPartyHookTargets) {
      await useSettingsStore.getState().update("thirdPartyHookTargets", remoteThirdPartyHookTargets);
      appliedSettingsKeys.push("thirdPartyHookTargets");
    }

    await db.execute(
      "INSERT OR REPLACE INTO sync_meta (id, device_id, last_sync_at, remote_version) VALUES ('singleton', ?, ?, ?)",
      [deviceId, data.last_modified, data.last_modified]
    );

    if (modelPricesMutated) {
      await useModelPricingStore.getState().load();
    }

    logInfo("Sync data applied successfully");
  } catch (error) {
    console.error("Failed to apply sync data, restoring backup:", error);

    if (appliedSettingsKeys.includes("thirdPartyHookNotificationsEnabled")) {
      try {
        await useSettingsStore.getState().update(
          "thirdPartyHookNotificationsEnabled",
          backupThirdPartyHookNotificationsEnabled,
        );
      } catch (restoreSettingsError) {
        console.error("Failed to restore synced notification enable setting:", restoreSettingsError);
      }
    }
    if (appliedSettingsKeys.includes("thirdPartyHookTargets")) {
      try {
        await useSettingsStore.getState().update("thirdPartyHookTargets", backupThirdPartyHookTargets);
      } catch (restoreSettingsError) {
        console.error("Failed to restore synced notification targets:", restoreSettingsError);
      }
    }
    if (appliedApplicationSettingKeys.length > 0) {
      try {
        const rollbackSettings: Record<string, unknown> = {};
        for (const key of appliedApplicationSettingKeys) {
          rollbackSettings[key] = backupApplicationSettings[key];
        }
        await applySyncedApplicationSettings(rollbackSettings);
      } catch (restoreSettingsError) {
        console.error("Failed to restore synced application settings:", restoreSettingsError);
      }
    }

    if (modelPricesMutated) {
      try {
        await db.execute("DELETE FROM model_prices");
        await insertModelPrices(backupModelPrices);
        await useModelPricingStore.getState().load();
      } catch (restoreError) {
        console.error("Failed to restore synced model prices:", restoreError);
      }
    }

    if (databaseMutated) {
      try {
        await db.execute("DELETE FROM command_templates");
        await db.execute("DELETE FROM worktrees");
        await db.execute("DELETE FROM projects");
        await db.execute("DELETE FROM groups");

        const backupGroupIds = new Set(backupGroups.map((group) => String(group.id)));
        const backupProjectIds = new Set(backupProjects.map((project) => String(project.id)));
        await insertGroups(backupGroups);
        await insertProjects(backupProjects, backupGroupIds);
        await insertWorktrees(backupWorktrees, backupProjectIds);
        await insertTemplates(backupTemplates, backupProjectIds);

        logInfo("Backup restored successfully");
      } catch (restoreError) {
        console.error("Failed to restore backup:", restoreError);
      }
    }

    throw error;
  }
}
