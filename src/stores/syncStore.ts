import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { getCliManagerDataPaths } from "../lib/appPaths";
import { batchInsert, getDb } from "../lib/db";
import { defaultShellForOs, getOsPlatform, isWindowsOnlyShellKey, normalizeShellForOs } from "../lib/shell";
import { singleFlight } from "../lib/singleFlight";
import { pickSyncableSettings, SYNCABLE_SETTING_KEYS, type SyncableSettingKey } from "../lib/syncSettings";
import { sanitizeThirdPartyHookTargets } from "../lib/thirdPartyNotifications";
import { useModelPricingStore } from "./modelPricingStore";
import { useProjectStore } from "./projectStore";
import { useSettingsStore } from "./settingsStore";
import { useWorktreeStore } from "./worktreeStore";

export type BackupStatus = "idle" | "backing_up" | "restoring" | "queued" | "success" | "error";
export type BackupMode = "cloud" | "local";
export type BackupDomain = "workspace" | "preferences" | "model_prices" | "notifications" | "statusline";

export interface BackupManifest {
  snapshotId: string;
  createdAt: string;
  appVersion: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  contentHash: string;
}

interface WorkspaceBackup {
  groups: Record<string, unknown>[];
  projects: Record<string, unknown>[];
  worktrees: Record<string, unknown>[];
  commandTemplates: Record<string, unknown>[];
}

export interface BackupSnapshotV3 {
  version: 3;
  manifest: BackupManifest;
  data: {
    workspace: WorkspaceBackup;
    preferences: Record<string, unknown>;
    modelPrices: Record<string, unknown>[];
    notifications: {
      enabled: boolean;
      targets: unknown[];
    };
    statusline: unknown;
  };
}

export interface BackupSnapshotInfo {
  remotePath: string;
  manifest: BackupManifest;
}

interface SyncMeta {
  device_id: string;
  last_sync_at: string | null;
}

interface LegacySyncData {
  version: number;
  device_id?: string;
  device_name?: string;
  last_modified?: string;
  data?: {
    projects?: Record<string, unknown>[];
    groups?: Record<string, unknown>[];
    command_templates?: Record<string, unknown>[];
    worktrees?: Record<string, unknown>[];
    model_prices?: Record<string, unknown>[];
    settings?: Record<string, unknown>;
  };
}

interface BackupStore {
  webdavUrl: string;
  webdavUsername: string;
  hasPassword: boolean;
  status: BackupStatus;
  lastBackupAt: string | null;
  deviceId: string;
  deviceName: string;
  loaded: boolean;
  backupMode: BackupMode;
  localBackupDir: string;
  remoteDir: string;
  autoBackupOnClose: boolean;
  snapshots: BackupSnapshotInfo[];
  load: () => Promise<void>;
  setConfig: (url: string, username: string, password?: string) => Promise<void>;
  clearPassword: () => Promise<void>;
  getSessionPassword: () => string;
  testConnection: (url: string, username: string, password: string) => Promise<{ success: boolean; message: string }>;
  setDeviceName: (name: string) => Promise<void>;
  setBackupMode: (mode: BackupMode) => Promise<void>;
  setLocalBackupDir: (dir: string) => Promise<void>;
  setRemoteDir: (dir: string) => Promise<void>;
  setAutoBackupOnClose: (enabled: boolean) => Promise<void>;
  createBackup: (manual?: boolean) => Promise<string | null>;
  listBackups: () => Promise<BackupSnapshotInfo[]>;
  previewBackup: (remotePath: string) => Promise<BackupSnapshotV3>;
  restoreBackup: (remotePath: string, domains: BackupDomain[]) => Promise<void>;
  importLegacyCloud: (domains: BackupDomain[]) => Promise<void>;
  deleteBackup: (remotePath: string) => Promise<void>;
  localImport: (zipPath: string, domains: BackupDomain[]) => Promise<void>;
  previewLocalImport: (zipPath: string) => Promise<BackupSnapshotV3>;
  undoLastRestore: () => Promise<void>;
  retryOutbox: () => Promise<void>;
  runCloseAutoBackup: () => Promise<"skipped" | "success" | "queued" | "error">;
}

const ALL_DOMAINS: BackupDomain[] = ["workspace", "preferences", "model_prices", "notifications", "statusline"];
const PROJECT_SELECT = "SELECT id, name, path, group_id, sort_order, cli_tool, cli_args, startup_cmd, env_vars, shell, provider_overrides, worktree_strategy, worktree_root, worktree_deps_prompt_enabled, environment_type, remote_path, created_at, updated_at FROM projects ORDER BY sort_order";
const GROUP_SELECT = "SELECT id, name, parent_id, sort_order, created_at FROM groups ORDER BY sort_order";
const TEMPLATE_SELECT = "SELECT id, project_id, name, command, description, sort_order FROM command_templates ORDER BY sort_order";
const WORKTREE_SELECT = "SELECT id, project_id, name, branch, path, base_branch, deps_prompt_dismissed, provider_overrides, status, created_at, updated_at FROM worktrees WHERE status = 'active' ORDER BY created_at DESC";
const MODEL_PRICE_COLUMNS = ["model", "input_per_1m", "output_per_1m", "cache_read_per_1m", "cache_creation_per_1m", "source", "source_model_id", "raw_json", "updated_at_ms", "synced_at_ms"] as const;
const MODEL_PRICE_SELECT = `SELECT ${MODEL_PRICE_COLUMNS.join(", ")} FROM model_prices ORDER BY model COLLATE NOCASE`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

let configStore: Store | null = null;
let sessionWebdavPassword = "";

async function getConfigStore() {
  if (!configStore) {
    const paths = await getCliManagerDataPaths();
    configStore = await Store.load(paths.syncStorePath, { autoSave: 0, defaults: {} });
  }
  return configStore;
}

function sanitizeDeviceName(value: string): string {
  return value.trim().replace(/[ .]+/g, "-").replace(/[^\p{Script=Han}A-Za-z0-9_-]/gu, "").slice(0, 64);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function webdavConfig(state: Pick<BackupStore, "webdavUrl" | "webdavUsername">) {
  return { url: state.webdavUrl, username: state.webdavUsername, password: sessionWebdavPassword };
}

async function collectBackupData(db: Awaited<ReturnType<typeof getDb>>): Promise<BackupSnapshotV3["data"]> {
  const [projects, groups, commandTemplates, worktrees, modelPrices, statusline] = await Promise.all([
    db.select<Record<string, unknown>[]>(PROJECT_SELECT),
    db.select<Record<string, unknown>[]>(GROUP_SELECT),
    db.select<Record<string, unknown>[]>(TEMPLATE_SELECT),
    db.select<Record<string, unknown>[]>(WORKTREE_SELECT),
    db.select<Record<string, unknown>[]>(MODEL_PRICE_SELECT),
    invoke<unknown>("statusline_backup_export"),
  ]);
  const settings = useSettingsStore.getState();
  return {
    workspace: { groups, projects, worktrees, commandTemplates },
    preferences: pickSyncableSettings(settings as unknown as Record<string, unknown>) as Record<string, unknown>,
    modelPrices,
    notifications: {
      enabled: settings.thirdPartyHookNotificationsEnabled,
      targets: sanitizeThirdPartyHookTargets(settings.thirdPartyHookTargets),
    },
    statusline,
  };
}

async function createSnapshot(deviceId: string, deviceName: string): Promise<BackupSnapshotV3> {
  const db = await getDb();
  const data = await collectBackupData(db);
  return {
    version: 3,
    manifest: {
      snapshotId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      appVersion: await getVersion(),
      deviceId,
      deviceName,
      platform: await getOsPlatform(),
      contentHash: await sha256(data),
    },
    data,
  };
}

async function normalizeImportedSnapshot(value: unknown, deviceId: string, deviceName: string): Promise<BackupSnapshotV3> {
  if (isRecord(value) && value.version === 3 && isRecord(value.manifest) && isRecord(value.data)) {
    const snapshot = value as unknown as BackupSnapshotV3;
    const manifest = snapshot.manifest;
    if (
      typeof manifest.snapshotId !== "string" ||
      typeof manifest.deviceId !== "string" ||
      typeof manifest.deviceName !== "string" ||
      typeof manifest.createdAt !== "string" ||
      typeof manifest.appVersion !== "string" ||
      typeof manifest.platform !== "string" ||
      typeof manifest.contentHash !== "string" ||
      !UUID_PATTERN.test(manifest.snapshotId) ||
      !UUID_PATTERN.test(manifest.deviceId) ||
      Number.isNaN(Date.parse(manifest.createdAt)) ||
      !SHA256_PATTERN.test(manifest.contentHash) ||
      !isRecord(snapshot.data.workspace) ||
      !isRecord(snapshot.data.preferences) ||
      !Array.isArray(snapshot.data.modelPrices) ||
      !isRecord(snapshot.data.notifications) ||
      !Object.prototype.hasOwnProperty.call(snapshot.data, "statusline") ||
      await sha256(snapshot.data) !== manifest.contentHash.toLowerCase()
    ) {
      throw new Error("backup_validation_failed");
    }
    return snapshot;
  }
  const legacy = value as LegacySyncData;
  if (!legacy || !isRecord(legacy.data)) throw new Error("backup_unsupported_format");
  const settings = isRecord(legacy.data.settings) ? legacy.data.settings : {};
  const data: BackupSnapshotV3["data"] = {
    workspace: {
      projects: Array.isArray(legacy.data.projects) ? legacy.data.projects : [],
      groups: Array.isArray(legacy.data.groups) ? legacy.data.groups : [],
      commandTemplates: Array.isArray(legacy.data.command_templates) ? legacy.data.command_templates : [],
      worktrees: Array.isArray(legacy.data.worktrees) ? legacy.data.worktrees : [],
    },
    preferences: pickSyncableSettings(settings) as Record<string, unknown>,
    modelPrices: Array.isArray(legacy.data.model_prices) ? legacy.data.model_prices : [],
    notifications: {
      enabled: settings.thirdPartyHookNotificationsEnabled === true,
      targets: sanitizeThirdPartyHookTargets(settings.thirdPartyHookTargets),
    },
    statusline: await invoke("statusline_backup_export"),
  };
  return {
    version: 3,
    manifest: {
      snapshotId: crypto.randomUUID(),
      createdAt: typeof legacy.last_modified === "string" ? legacy.last_modified : new Date().toISOString(),
      appVersion: await getVersion(),
      deviceId: typeof legacy.device_id === "string" ? legacy.device_id : deviceId,
      deviceName: typeof legacy.device_name === "string" ? legacy.device_name : deviceName,
      platform: await getOsPlatform(),
      contentHash: await sha256(data),
    },
    data,
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function normalizeWorktreeStrategy(value: unknown): string {
  return value === "prompt" || value === "autoParallel" || value === "always" ? value : "disabled";
}

async function applyPreferences(preferences: Record<string, unknown>) {
  for (const key of SYNCABLE_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(preferences, key)) continue;
    await useSettingsStore.getState().update(key as SyncableSettingKey, preferences[key] as never);
  }
  await useSettingsStore.getState().load();
}

async function replaceWorkspace(db: Awaited<ReturnType<typeof getDb>>, workspace: WorkspaceBackup) {
  const now = Date.now().toString();
  const os = await getOsPlatform();
  const platformDefaultShell = defaultShellForOs(os);
  const groups = Array.isArray(workspace.groups) ? workspace.groups : [];
  const projects = Array.isArray(workspace.projects) ? workspace.projects : [];
  const worktrees = Array.isArray(workspace.worktrees) ? workspace.worktrees : [];
  const templates = Array.isArray(workspace.commandTemplates) ? workspace.commandTemplates : [];
  const groupIds = new Set(groups.map((item) => String(item.id)));
  const projectIds = new Set(projects.map((item) => String(item.id)));
  await db.execute("DELETE FROM command_templates");
  await db.execute("DELETE FROM worktrees");
  await db.execute("DELETE FROM projects");
  await db.execute("DELETE FROM groups");
  await batchInsert(db, "groups", ["id", "name", "parent_id", "sort_order", "created_at"], groups, (item) => [
    item.id, item.name, typeof item.parent_id === "string" && groupIds.has(item.parent_id) ? item.parent_id : null,
    integerOr(item.sort_order, 0), item.created_at ?? now,
  ]);
  await batchInsert(
    db,
    "projects",
    ["id", "name", "path", "group_id", "sort_order", "cli_tool", "cli_args", "startup_cmd", "env_vars", "shell", "provider_overrides", "worktree_strategy", "worktree_root", "worktree_deps_prompt_enabled", "environment_type", "ssh_host_id", "remote_path", "created_at", "updated_at"],
    projects,
    (item) => {
      const environmentType = item.environment_type === "ssh" ? "ssh" : item.environment_type === "wsl" ? "wsl" : "local";
      const isSshProject = environmentType === "ssh";
      const rawShell = typeof item.shell === "string" ? item.shell.trim() : "";
      const shell = isSshProject
        ? ""
        : normalizeShellForOs(rawShell, os)
          ?? (rawShell && !(os !== "windows" && isWindowsOnlyShellKey(rawShell)) ? rawShell : platformDefaultShell);
      return [
        item.id, item.name, isSshProject ? "" : item.path,
        typeof item.group_id === "string" && groupIds.has(item.group_id) ? item.group_id : null,
        integerOr(item.sort_order, 0), item.cli_tool ?? "", item.cli_args ?? "", item.startup_cmd ?? "",
        item.env_vars ?? "{}", shell, isSshProject ? "{}" : item.provider_overrides ?? "{}",
        isSshProject ? "disabled" : normalizeWorktreeStrategy(item.worktree_strategy),
        isSshProject ? "" : item.worktree_root ?? "", isSshProject ? 0 : integerOr(item.worktree_deps_prompt_enabled, 0),
        environmentType, null, isSshProject && typeof item.remote_path === "string" ? item.remote_path : "",
        item.created_at ?? now, item.updated_at ?? now,
      ];
    },
  );
  await batchInsert(db, "worktrees", ["id", "project_id", "name", "branch", "path", "base_branch", "deps_prompt_dismissed", "provider_overrides", "status", "created_at", "updated_at"], worktrees.filter((item) => typeof item.project_id === "string" && projectIds.has(item.project_id)), (item) => [
    item.id, item.project_id, item.name, item.branch, item.path, item.base_branch ?? "", integerOr(item.deps_prompt_dismissed, 0),
    item.provider_overrides ?? "{}", item.status === "missing" ? "missing" : "active", item.created_at ?? now, item.updated_at ?? now,
  ]);
  await batchInsert(db, "command_templates", ["id", "project_id", "name", "command", "description", "sort_order"], templates, (item) => [
    item.id, typeof item.project_id === "string" && projectIds.has(item.project_id) ? item.project_id : null,
    item.name, item.command, item.description ?? "", integerOr(item.sort_order, 0),
  ]);
}

async function replaceModelPrices(db: Awaited<ReturnType<typeof getDb>>, prices: Record<string, unknown>[]) {
  const normalized = prices.filter(isRecord).map((item) => ({
    model: typeof item.model === "string" ? item.model : "",
    input_per_1m: numberOrZero(item.input_per_1m), output_per_1m: numberOrZero(item.output_per_1m),
    cache_read_per_1m: numberOrZero(item.cache_read_per_1m), cache_creation_per_1m: numberOrZero(item.cache_creation_per_1m),
    source: typeof item.source === "string" ? item.source : "manual", source_model_id: item.source_model_id ?? null,
    raw_json: item.raw_json ?? null, updated_at_ms: integerOr(item.updated_at_ms, 0),
    synced_at_ms: item.synced_at_ms == null ? null : integerOr(item.synced_at_ms, 0),
  })).filter((item) => item.model);
  await db.execute("DELETE FROM model_prices");
  await batchInsert(db, "model_prices", MODEL_PRICE_COLUMNS, normalized, (item) => MODEL_PRICE_COLUMNS.map((column) => item[column]));
}

async function applySnapshot(snapshot: BackupSnapshotV3, domains: BackupDomain[]) {
  if (snapshot.version !== 3 || !isRecord(snapshot.data)) throw new Error("backup_invalid_v3");
  const selected = new Set(domains);
  const db = await getDb();
  const changesDatabase = selected.has("workspace") || selected.has("model_prices");
  if (changesDatabase) await db.execute("BEGIN IMMEDIATE");
  try {
    if (selected.has("workspace")) await replaceWorkspace(db, snapshot.data.workspace);
    if (selected.has("model_prices")) await replaceModelPrices(db, snapshot.data.modelPrices);
    if (changesDatabase) await db.execute("COMMIT");
  } catch (error) {
    if (changesDatabase) await db.execute("ROLLBACK").catch(() => undefined);
    throw error;
  }
  if (selected.has("preferences")) await applyPreferences(snapshot.data.preferences);
  if (selected.has("notifications")) {
    await useSettingsStore.getState().update("thirdPartyHookNotificationsEnabled", snapshot.data.notifications.enabled);
    await useSettingsStore.getState().update("thirdPartyHookTargets", sanitizeThirdPartyHookTargets(snapshot.data.notifications.targets));
  }
  if (selected.has("statusline")) await invoke("statusline_backup_restore", { bundle: snapshot.data.statusline });
  if (selected.has("model_prices")) await useModelPricingStore.getState().load();
  if (selected.has("workspace")) {
    await useProjectStore.getState().fetchAll();
    await useWorktreeStore.getState().loadWorktrees();
    await useProjectStore.getState().refreshProjectDiagnostics();
    await useWorktreeStore.getState().markMissingWorktrees();
  }
}

export const useSyncStore = create<BackupStore>((set, get) => ({
  webdavUrl: "", webdavUsername: "", hasPassword: false, status: "idle", lastBackupAt: null,
  deviceId: "", deviceName: "", loaded: false, backupMode: "cloud", localBackupDir: "", remoteDir: "",
  autoBackupOnClose: false, snapshots: [],

  load: singleFlight(async () => {
    const store = await getConfigStore();
    const webdavUrl = (await store.get<string>("webdavUrl")) ?? "";
    const webdavUsername = (await store.get<string>("webdavUsername")) ?? "";
    sessionWebdavPassword = (await invoke<string | null>("sync_load_password").catch(() => null)) ?? "";
    let deviceName = sanitizeDeviceName((await store.get<string>("deviceName")) ?? "");
    if (!deviceName) {
      const result = await invoke<{ device_name: string }>("sync_get_default_device_name").catch(() => ({ device_name: "当前设备" }));
      deviceName = sanitizeDeviceName(result.device_name) || "当前设备";
      await store.set("deviceName", deviceName);
    }
    const oldCloseAction = await store.get<string>("autoSyncOnClose");
    const autoBackupOnClose = (await store.get<boolean>("autoBackupOnClose")) ?? oldCloseAction === "upload";
    await store.set("autoBackupOnClose", autoBackupOnClose);
    await store.set("autoSyncOnStartup", "off");
    await store.set("autoSyncOnClose", "off");
    const db = await getDb();
    const meta = await db.select<SyncMeta[]>("SELECT device_id, last_sync_at FROM sync_meta WHERE id = 'singleton'");
    set({
      webdavUrl, webdavUsername, hasPassword: Boolean(sessionWebdavPassword), deviceName,
      deviceId: meta[0]?.device_id ?? crypto.randomUUID(), lastBackupAt: meta[0]?.last_sync_at ?? null,
      backupMode: ((await store.get<string>("syncMode")) === "local" ? "local" : "cloud"),
      localBackupDir: (await store.get<string>("localSyncDir")) ?? "", remoteDir: (await store.get<string>("remoteDir")) ?? "",
      autoBackupOnClose, loaded: true,
    });
  }),

  setConfig: async (url, username, password) => {
    const store = await getConfigStore();
    await store.set("webdavUrl", url); await store.set("webdavUsername", username);
    if (password !== undefined) {
      await invoke(password ? "sync_save_password" : "sync_delete_password", password ? { password } : undefined);
      sessionWebdavPassword = password;
    }
    set({ webdavUrl: url, webdavUsername: username, hasPassword: Boolean(sessionWebdavPassword) });
  },
  clearPassword: async () => { await invoke("sync_delete_password"); sessionWebdavPassword = ""; set({ hasPassword: false }); },
  getSessionPassword: () => sessionWebdavPassword,
  testConnection: (url, username, password) => invoke("sync_test_connection", { config: { url, username, password } }),
  setDeviceName: async (name) => {
    const value = sanitizeDeviceName(name); if (!value) throw new Error("backup_device_name_required");
    await (await getConfigStore()).set("deviceName", value); set({ deviceName: value });
  },
  setBackupMode: async (mode) => { await (await getConfigStore()).set("syncMode", mode); set({ backupMode: mode }); },
  setLocalBackupDir: async (dir) => { await (await getConfigStore()).set("localSyncDir", dir); set({ localBackupDir: dir }); },
  setRemoteDir: async (dir) => { await (await getConfigStore()).set("remoteDir", dir); set({ remoteDir: dir }); },
  setAutoBackupOnClose: async (enabled) => { await (await getConfigStore()).set("autoBackupOnClose", enabled); set({ autoBackupOnClose: enabled }); },

  createBackup: async (manual = true) => {
    const state = get();
    set({ status: "backing_up" });
    try {
      const snapshot = await createSnapshot(state.deviceId, state.deviceName);
      const store = await getConfigStore();
      const lastHash = (await store.get<string>("lastBackupContentHash")) ?? "";
      if (!manual && lastHash === snapshot.manifest.contentHash) { set({ status: "idle" }); return null; }
      let result: string;
      if (state.backupMode === "local") {
        if (!state.localBackupDir) throw new Error("backup_local_directory_required");
        result = await invoke("backup_local_export", { dir: state.localBackupDir, snapshot });
      } else {
        if (!state.webdavUrl || !sessionWebdavPassword) throw new Error("backup_webdav_required");
        const targetHash = await sha256([state.webdavUrl, state.webdavUsername, state.remoteDir]);
        await invoke("backup_outbox_save", { targetHash, snapshot });
        try {
          result = await invoke("backup_upload", { config: webdavConfig(state), snapshot, remoteDir: state.remoteDir || undefined });
          await invoke("backup_outbox_remove", { targetHash, snapshotId: snapshot.manifest.snapshotId });
        } catch {
          await store.set("lastBackupContentHash", snapshot.manifest.contentHash);
          const db = await getDb();
          await db.execute("INSERT OR REPLACE INTO sync_meta (id, device_id, last_sync_at, remote_version) VALUES ('singleton', ?, ?, ?)", [state.deviceId, snapshot.manifest.createdAt, snapshot.manifest.contentHash]);
          set({ status: "queued", lastBackupAt: snapshot.manifest.createdAt });
          throw new Error("backup_queued");
        }
      }
      await store.set("lastBackupContentHash", snapshot.manifest.contentHash);
      const db = await getDb();
      await db.execute("INSERT OR REPLACE INTO sync_meta (id, device_id, last_sync_at, remote_version) VALUES ('singleton', ?, ?, ?)", [state.deviceId, snapshot.manifest.createdAt, snapshot.manifest.contentHash]);
      set({ status: "success", lastBackupAt: snapshot.manifest.createdAt });
      return result;
    } catch (error) {
      if (!(error instanceof Error && error.message === "backup_queued")) set({ status: "error" });
      throw error;
    }
  },

  listBackups: async () => {
    const state = get();
    if (!state.webdavUrl || !sessionWebdavPassword) return [];
    const snapshots = await invoke<BackupSnapshotInfo[]>("backup_list", { config: webdavConfig(state), remoteDir: state.remoteDir || undefined });
    set({ snapshots }); return snapshots;
  },
  previewBackup: async (remotePath) => {
    const state = get();
    const raw = await invoke<unknown>("backup_download", { config: webdavConfig(state), remotePath, remoteDir: state.remoteDir || undefined });
    return normalizeImportedSnapshot(raw, state.deviceId, state.deviceName);
  },
  restoreBackup: async (remotePath, domains) => {
    const state = get(); set({ status: "restoring" });
    const safety = await createSnapshot(state.deviceId, state.deviceName);
    await invoke("backup_restore_safety_save", { snapshot: safety });
    try {
      const raw = await invoke<unknown>("backup_download", { config: webdavConfig(state), remotePath, remoteDir: state.remoteDir || undefined });
      const snapshot = await normalizeImportedSnapshot(raw, state.deviceId, state.deviceName);
      await applySnapshot(snapshot, domains); set({ status: "success", lastBackupAt: snapshot.manifest.createdAt });
    } catch (error) {
      await applySnapshot(safety, ALL_DOMAINS).catch((rollbackError) => console.error("Restore rollback failed", rollbackError));
      set({ status: "error" }); throw error;
    }
  },
  importLegacyCloud: async (domains) => {
    const state = get(); set({ status: "restoring" });
    const safety = await createSnapshot(state.deviceId, state.deviceName);
    await invoke("backup_restore_safety_save", { snapshot: safety });
    try {
      const raw = await invoke<unknown>("backup_import_legacy_cloud", {
        config: webdavConfig(state), deviceName: state.deviceName, remoteDir: state.remoteDir || undefined,
      });
      const snapshot = await normalizeImportedSnapshot(raw, state.deviceId, state.deviceName);
      await applySnapshot(snapshot, domains); set({ status: "success" });
    } catch (error) {
      await applySnapshot(safety, ALL_DOMAINS).catch((rollbackError) => console.error("Legacy restore rollback failed", rollbackError));
      set({ status: "error" }); throw error;
    }
  },
  deleteBackup: async (remotePath) => {
    const state = get();
    await invoke("backup_delete", { config: webdavConfig(state), remotePath, remoteDir: state.remoteDir || undefined });
    await get().listBackups();
  },
  localImport: async (zipPath, domains) => {
    const state = get(); set({ status: "restoring" });
    const safety = await createSnapshot(state.deviceId, state.deviceName);
    await invoke("backup_restore_safety_save", { snapshot: safety });
    try {
      const raw = await invoke<unknown>("backup_local_import", { zipPath });
      const snapshot = await normalizeImportedSnapshot(raw, state.deviceId, state.deviceName);
      await applySnapshot(snapshot, domains); set({ status: "success" });
    } catch (error) {
      await applySnapshot(safety, ALL_DOMAINS).catch((rollbackError) => console.error("Import rollback failed", rollbackError));
      set({ status: "error" }); throw error;
    }
  },
  previewLocalImport: async (zipPath) => {
    const state = get();
    const raw = await invoke<unknown>("backup_local_import", { zipPath });
    return normalizeImportedSnapshot(raw, state.deviceId, state.deviceName);
  },
  undoLastRestore: async () => {
    const raw = await invoke<unknown | null>("backup_restore_safety_load");
    if (!raw) throw new Error("backup_no_restore_to_undo");
    const state = get();
    const snapshot = await normalizeImportedSnapshot(raw, state.deviceId, state.deviceName);
    set({ status: "restoring" });
    try {
      await applySnapshot(snapshot, ALL_DOMAINS);
      await invoke("backup_restore_safety_clear");
      set({ status: "success" });
    }
    catch (error) { set({ status: "error" }); throw error; }
  },
  retryOutbox: async () => {
    const state = get();
    if (!state.webdavUrl || !sessionWebdavPassword) return;
    const targetHash = await sha256([state.webdavUrl, state.webdavUsername, state.remoteDir]);
    const snapshots = await invoke<BackupSnapshotV3[]>("backup_outbox_list", { targetHash });
    for (const snapshot of snapshots) {
      try {
        await invoke("backup_upload", { config: webdavConfig(state), snapshot, remoteDir: state.remoteDir || undefined });
        await invoke("backup_outbox_remove", { targetHash, snapshotId: snapshot.manifest.snapshotId });
      } catch (error) { console.warn("Backup outbox retry failed", error); break; }
    }
  },
  runCloseAutoBackup: async () => {
    const state = get();
    if (!state.autoBackupOnClose) return "skipped";
    try { const result = await get().createBackup(false); return result === null ? "skipped" : "success"; }
    catch { return state.backupMode === "cloud" ? "queued" : "error"; }
  },
}));
