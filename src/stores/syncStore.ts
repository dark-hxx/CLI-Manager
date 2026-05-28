import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { getDb, batchInsert } from "../lib/db";
import { useProjectStore } from "./projectStore";

export type SyncStatus = "idle" | "syncing" | "success" | "error" | "conflict";
export type SyncMode = "cloud" | "local";
export type AutoSyncAction = "off" | "upload" | "download";
export type SyncDataDomain = "projects" | "groups" | "command_templates";

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

  load: () => Promise<void>;
  setConfig: (url: string, username: string, password?: string) => Promise<void>;
  clearPassword: () => Promise<void>;
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
  localExport: () => Promise<string>;
  localImport: (zipPath: string) => Promise<void>;
}

let store: Store | null = null;
async function getStore() {
  if (!store) {
    store = await Store.load("sync-config.json", { autoSave: 100, defaults: {} });
  }
  return store;
}

const SYNC_DATA_VERSION = 1;
const AUTO_SYNC_ACTIONS: readonly AutoSyncAction[] = ["off", "upload", "download"];
const SYNC_DATA_DOMAINS: readonly SyncDataDomain[] = ["projects", "groups", "command_templates"];
const HTTP_NOT_FOUND_PATTERN = /HTTP error:\s*404\b/i;
const REMOTE_SYNC_UNAVAILABLE_MESSAGE = "无法从云端同步";

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
): Promise<SyncDownloadCommandResult> {
  return invoke<SyncDownloadCommandResult>("sync_download", {
    config: { url: webdavUrl, username: webdavUsername, password },
    localData,
    force,
    deviceName,
  });
}

function isConfigured(state: Pick<SyncStore, "syncMode" | "webdavUrl" | "hasPassword">): boolean {
  return state.syncMode === "cloud" && Boolean(state.webdavUrl.trim()) && state.hasPassword;
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

  load: async () => {
    const s = await getStore();
    const url = (await s.get<string>("webdavUrl")) ?? "";
    const username = (await s.get<string>("webdavUsername")) ?? "";
    const hasPassword = (await s.get<boolean>("hasPassword")) ?? false;
    const syncMode = ((await s.get<string>("syncMode")) as SyncMode | undefined) ?? "cloud";
    const localSyncDir = (await s.get<string>("localSyncDir")) ?? "";
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
      autoSyncOnStartup,
      autoSyncOnClose,
      loaded: true,
    });
  },

  setConfig: async (url, username, password) => {
    const s = await getStore();
    await s.set("webdavUrl", url);
    await s.set("webdavUsername", username);
    if (password !== undefined) {
      await s.set("hasPassword", true);
      await s.set("webdavPassword", password);
      set({ webdavUrl: url, webdavUsername: username, hasPassword: true });
    } else {
      // Preserve existing hasPassword state when not providing new password
      set({ webdavUrl: url, webdavUsername: username });
    }
  },

  clearPassword: async () => {
    const s = await getStore();
    await s.set("hasPassword", false);
    await s.set("webdavPassword", "");
    set({ hasPassword: false });
  },

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
    const { webdavUrl, webdavUsername, deviceId, deviceName } = get();
    const s = await getStore();
    const password = (await s.get<string>("webdavPassword")) ?? "";

    if (!webdavUrl || !password) {
      set({ status: "error" });
      return;
    }

    set({ status: "syncing" });

    try {
      const db = await getDb();

      const projects = await db.select<Record<string, unknown>[]>(
        "SELECT id, name, path, group_id, sort_order, cli_tool, startup_cmd, env_vars, shell FROM projects ORDER BY sort_order"
      );
      const groups = await db.select<Record<string, unknown>[]>(
        "SELECT id, name, parent_id, sort_order FROM groups ORDER BY sort_order"
      );
      const templates = await db.select<Record<string, unknown>[]>(
        "SELECT id, project_id, name, command, description, sort_order FROM command_templates ORDER BY sort_order"
      );

      const syncData: SyncData = {
        version: SYNC_DATA_VERSION,
        device_id: deviceId,
        device_name: deviceName,
        last_modified: new Date().toISOString(),
        data: {
          projects,
          groups,
          command_templates: templates,
          settings: {},
        },
      };

      await invoke("sync_upload", {
        config: { url: webdavUrl, username: webdavUsername, password },
        data: syncData,
      });

      const now = new Date().toISOString();
      await db.execute(
        "INSERT OR REPLACE INTO sync_meta (id, device_id, last_sync_at, remote_version) VALUES ('singleton', ?, ?, ?)",
        [deviceId, now, now]
      );

      set({ status: "success", lastSyncAt: now });
    } catch (error) {
      console.error("Upload failed:", error);
      set({ status: "error" });
      throw error; // Re-throw to let UI show the error
    }
  },

  download: async (force = false, options) => {
    const { webdavUrl, webdavUsername, deviceId, deviceName } = get();
    const s = await getStore();
    const password = (await s.get<string>("webdavPassword")) ?? "";

    if (!webdavUrl || !password) {
      set({ status: "error" });
      return;
    }

    set({ status: "syncing" });

    try {
      const db = await getDb();

      const localProjects = await db.select<Record<string, unknown>[]>(
        "SELECT id, name, path, group_id, sort_order, cli_tool, startup_cmd, env_vars, shell FROM projects ORDER BY sort_order"
      );
      const localGroups = await db.select<Record<string, unknown>[]>(
        "SELECT id, name, parent_id, sort_order FROM groups ORDER BY sort_order"
      );
      const localTemplates = await db.select<Record<string, unknown>[]>(
        "SELECT id, project_id, name, command, description, sort_order FROM command_templates ORDER BY sort_order"
      );

      const localData: SyncData = {
        version: SYNC_DATA_VERSION,
        device_id: deviceId,
        device_name: deviceName,
        last_modified: get().lastSyncAt ?? new Date(0).toISOString(),
        data: {
          projects: localProjects,
          groups: localGroups,
          command_templates: localTemplates,
          settings: {},
        },
      };

      const result = await downloadRemoteSnapshot(
        webdavUrl,
        webdavUsername,
        password,
        localData,
        force,
        options?.deviceName ?? deviceName,
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
      // Refresh project list after sync
      useProjectStore.getState().fetchAll().catch(console.error);
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
    const { webdavUrl, webdavUsername, deviceId, deviceName } = get();
    const s = await getStore();
    const password = (await s.get<string>("webdavPassword")) ?? "";
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
    const { webdavUrl, webdavUsername, knownDeviceNames } = get();
    const s = await getStore();
    const password = (await s.get<string>("webdavPassword")) ?? "";
    if (!webdavUrl || !password) return [];
    return invoke<DeviceSnapshotInfo[]>("sync_list_device_snapshots", {
      config: { url: webdavUrl, username: webdavUsername, password },
      deviceNames: knownDeviceNames,
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
      // Refresh project list after sync
      useProjectStore.getState().fetchAll().catch(console.error);
      set({
        status: "success",
        lastSyncAt: pendingRemoteData.last_modified,
        conflictInfo: null,
        pendingRemoteData: null,
      });
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

  localExport: async () => {
    const { localSyncDir, deviceId, deviceName } = get();
    if (!localSyncDir) {
      throw new Error("请先选择本地同步目录");
    }
    set({ status: "syncing" });
    try {
      const db = await getDb();
      const projects = await db.select<Record<string, unknown>[]>(
        "SELECT id, name, path, group_id, sort_order, cli_tool, startup_cmd, env_vars, shell FROM projects ORDER BY sort_order"
      );
      const groups = await db.select<Record<string, unknown>[]>(
        "SELECT id, name, parent_id, sort_order FROM groups ORDER BY sort_order"
      );
      const templates = await db.select<Record<string, unknown>[]>(
        "SELECT id, project_id, name, command, description, sort_order FROM command_templates ORDER BY sort_order"
      );

      const now = new Date().toISOString();
      const syncData: SyncData = {
        version: SYNC_DATA_VERSION,
        device_id: deviceId,
        device_name: deviceName,
        last_modified: now,
        data: {
          projects,
          groups,
          command_templates: templates,
          settings: {},
        },
      };

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
      useProjectStore.getState().fetchAll().catch(console.error);
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
  const projects = await db.select<Record<string, unknown>[]>(
    "SELECT id, name, path, group_id, sort_order, cli_tool, startup_cmd, env_vars, shell FROM projects ORDER BY sort_order"
  );
  const groups = await db.select<Record<string, unknown>[]>(
    "SELECT id, name, parent_id, sort_order FROM groups ORDER BY sort_order"
  );
  const commandTemplates = await db.select<Record<string, unknown>[]>(
    "SELECT id, project_id, name, command, description, sort_order FROM command_templates ORDER BY sort_order"
  );
  return {
    version: SYNC_DATA_VERSION,
    device_id: deviceId,
    device_name: deviceName,
    last_modified: lastModified,
    data: {
      projects,
      groups,
      command_templates: commandTemplates,
      settings: {},
    },
  };
}

function summarizeSyncData(data: SyncData, fallbackDeviceName: string): SyncSnapshotSummary {
  return {
    deviceName: data.device_name?.trim() || fallbackDeviceName,
    lastModified: data.last_modified,
    projects: data.data.projects.length,
    groups: data.data.groups.length,
    commandTemplates: data.data.command_templates.length,
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
  const backupProjects = await db.select<Record<string, unknown>[]>("SELECT * FROM projects");
  const backupGroups = await db.select<Record<string, unknown>[]>("SELECT * FROM groups");
  const backupTemplates = await db.select<Record<string, unknown>[]>("SELECT * FROM command_templates");

  const nowStr = Date.now().toString();

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
      ["id", "name", "path", "group_id", "sort_order", "cli_tool", "startup_cmd", "env_vars", "shell", "created_at", "updated_at"],
      projects,
      (project) => {
        const groupId = typeof project.group_id === "string" && validGroupIds.has(project.group_id) ? project.group_id : null;
        return [
          project.id as string,
          project.name as string,
          project.path as string,
          groupId,
          project.sort_order as number,
          (project.cli_tool as string) ?? "",
          (project.startup_cmd as string) ?? "",
          (project.env_vars as string) ?? "{}",
          (project.shell as string) ?? "powershell",
          (project.created_at as string) ?? nowStr,
          (project.updated_at as string) ?? nowStr,
        ];
      },
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

  try {
    if (shouldApplyTemplates || shouldApplyProjects || shouldApplyGroups) {
      await db.execute("DELETE FROM command_templates");
    }
    if (shouldApplyProjects || shouldApplyGroups) {
      await db.execute("DELETE FROM projects");
    }
    if (shouldApplyGroups) {
      await db.execute("DELETE FROM groups");
    }

    const finalGroups = shouldApplyGroups ? data.data.groups : backupGroups;
    const finalProjects = shouldApplyProjects ? data.data.projects : backupProjects;
    const finalTemplates = shouldApplyTemplates ? data.data.command_templates : backupTemplates;
    const finalGroupIds = new Set(finalGroups.map((group) => String(group.id)));
    const finalProjectIds = new Set(finalProjects.map((project) => String(project.id)));

    if (shouldApplyGroups) {
      await insertGroups(finalGroups);
    }
    if (shouldApplyProjects || shouldApplyGroups) {
      await insertProjects(finalProjects, finalGroupIds);
    }
    if (shouldApplyTemplates || shouldApplyProjects || shouldApplyGroups) {
      await insertTemplates(finalTemplates, finalProjectIds);
    }

    await db.execute(
      "INSERT OR REPLACE INTO sync_meta (id, device_id, last_sync_at, remote_version) VALUES ('singleton', ?, ?, ?)",
      [deviceId, data.last_modified, data.last_modified]
    );

    console.log("Sync data applied successfully");
  } catch (error) {
    console.error("Failed to apply sync data, restoring backup:", error);

    try {
      await db.execute("DELETE FROM command_templates");
      await db.execute("DELETE FROM projects");
      await db.execute("DELETE FROM groups");

      const backupGroupIds = new Set(backupGroups.map((group) => String(group.id)));
      const backupProjectIds = new Set(backupProjects.map((project) => String(project.id)));
      await insertGroups(backupGroups);
      await insertProjects(backupProjects, backupGroupIds);
      await insertTemplates(backupTemplates, backupProjectIds);

      console.log("Backup restored successfully");
    } catch (restoreError) {
      console.error("Failed to restore backup:", restoreError);
    }

    throw error;
  }
}