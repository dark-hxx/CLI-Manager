import { invoke } from "@tauri-apps/api/core";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useSshHostStore } from "../stores/sshHostStore";
import { useWorktreeStore } from "../stores/worktreeStore";
import type { CreateSshHostInput, Project, SshAuthMode, UpdateSshHostInput, WorktreeRecord } from "./types";
import { buildSshConnectionSpec } from "./ssh";
import { findProjectByPath, findWorktreeByPath, normalizeProjectPath } from "./terminalProject";
import { webDeviceApi, type WebDeviceOperation } from "./webDevice";

const MANAGEMENT_KINDS = new Set([
  "ssh.hosts.list", "ssh.client_status", "ssh.test_connection", "ssh.check_path", "ssh.list_directories",
  "ssh.host.create", "ssh.host.update", "ssh.host.delete",
  "file.list", "file.search", "file.search_content", "file.create", "file.create_directory",
  "file.rename", "file.copy", "file.move", "file.delete",
  "git.status", "git.branches", "git.fetch", "git.checkout", "git.create_branch", "git.stage",
  "git.unstage", "git.commit", "git.pull", "git.push", "git.discard", "git.delete_untracked",
  "worktree.list", "worktree.create", "worktree.check_deps", "worktree.merge", "worktree.remove",
  "hook.status", "hook.install", "hook.repair", "hook.test", "hook.uninstall",
]);

const CONFIRMED_KINDS = new Set([
  "ssh.host.create", "ssh.host.update", "ssh.host.delete",
  "file.create", "file.create_directory", "file.rename", "file.copy", "file.move", "file.delete",
  "git.fetch", "git.checkout", "git.create_branch", "git.stage", "git.unstage", "git.commit", "git.pull", "git.push",
  "git.discard", "git.delete_untracked", "worktree.create", "worktree.merge", "worktree.remove",
  "hook.install", "hook.repair", "hook.uninstall",
]);

const SAFE_SSH_AUTH_MODES = new Set<SshAuthMode>(["ssh_config", "agent", "password_prompt", "interactive"]);

type Payload = Record<string, unknown>;

type LocalContext = {
  project: Project;
  worktree: WorktreeRecord | null;
  rootPath: string;
};

function managementError(code: string, message = code): never {
  throw { code, message };
}

function payloadObject(operation: WebDeviceOperation): Payload {
  if (!operation.payload || typeof operation.payload !== "object" || Array.isArray(operation.payload)) {
    managementError("invalid_operation_payload", "operation payload must be an object");
  }
  return operation.payload as Payload;
}

function requiredString(payload: Payload, key: string, maxLength = 4096): string {
  const value = typeof payload[key] === "string" ? payload[key].trim() : "";
  if (!value || value.length > maxLength || /[\0\r\n]/.test(value)) {
    managementError("invalid_operation_payload", `${key} is invalid`);
  }
  return value;
}

function optionalString(payload: Payload, key: string, maxLength = 4096): string | undefined {
  if (payload[key] === undefined || payload[key] === null) return undefined;
  if (typeof payload[key] === "string" && !payload[key].trim()) return undefined;
  return requiredString(payload, key, maxLength);
}

function booleanValue(payload: Payload, key: string, fallback = false): boolean {
  return typeof payload[key] === "boolean" ? payload[key] : fallback;
}

function numberValue(payload: Payload, key: string, fallback: number, min: number, max: number): number {
  const value = payload[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    managementError("invalid_operation_payload", `${key} is invalid`);
  }
  return value;
}

function stringArray(payload: Payload, key: string, maxItems = 500): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    managementError("invalid_operation_payload", `${key} is invalid`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 4096 || /[\0\r\n]/.test(item)) {
      managementError("invalid_operation_payload", `${key} contains an invalid item`);
    }
    return item.trim();
  });
}

function requireConfirmation(operation: WebDeviceOperation, payload: Payload) {
  if (CONFIRMED_KINDS.has(operation.kind) && payload.confirmed !== true) {
    managementError("operation_confirmation_required", "explicit confirmation is required");
  }
  if (operation.kind === "ssh.test_connection" && payload.acceptNewHostKey === true && payload.confirmed !== true) {
    managementError("operation_confirmation_required", "accepting a new SSH host key requires confirmation");
  }
}

async function resolveLocalContext(payload: Payload): Promise<LocalContext> {
  const projectKey = requiredString(payload, "projectKey", 512);
  const cwd = requiredString(payload, "cwd");
  const historyStore = useHistoryStore.getState();
  await historyStore.loadSessions();
  const historyMatch = useHistoryStore.getState().sessions.some((session) => (
    session.project_key === projectKey
    && normalizeProjectPath(session.cwd?.trim() || "") === normalizeProjectPath(cwd)
  ));
  if (!historyMatch) managementError("history_context_not_found", "project context does not match desktop history");

  const projectStore = useProjectStore.getState();
  if (!projectStore.loaded) await projectStore.fetchAll("startup");
  const { projects, worktrees } = useProjectStore.getState();
  const worktree = findWorktreeByPath(worktrees, cwd);
  const project = worktree
    ? projects.find((item) => item.id === worktree.project_id) ?? null
    : findProjectByPath(projects, cwd);
  if (!project) managementError("project_not_found", "desktop project context was not found");
  if (project.environment_type === "ssh") managementError("ssh_project_unsupported", "local management is unavailable for SSH projects");
  if (worktree?.status === "missing") managementError("worktree_missing", "target Worktree no longer exists");
  const rootPath = worktree?.path ?? project.path;
  await webDeviceApi.validateContext(rootPath, cwd);
  return { project, worktree: worktree ?? null, rootPath };
}

async function ensureSshHostsLoaded() {
  const store = useSshHostStore.getState();
  if (!store.loaded) await store.fetchHosts();
  if (useSshHostStore.getState().loadError) managementError("ssh_hosts_load_failed", useSshHostStore.getState().loadError!);
}

function publicSshHost(host: ReturnType<typeof useSshHostStore.getState>["hosts"][number]) {
  return {
    id: host.id,
    name: host.name,
    groupName: host.group_name,
    groupId: host.group_id,
    port: host.port,
    authMode: host.auth_mode,
    jumpMode: host.jump_mode,
    jumpHostId: host.jump_host_id,
    proxyType: host.proxy_type,
    connectTimeoutSec: host.connect_timeout_sec,
    serverAliveIntervalSec: host.server_alive_interval_sec,
    serverAliveCountMax: host.server_alive_count_max,
    terminalEncoding: host.terminal_encoding,
    hasIdentityFile: Boolean(host.identity_file),
    hasCredential: Boolean(host.credential_ref),
    hasProxyCommand: Boolean(host.proxy_command),
    updatedAt: host.updated_at,
  };
}

function publicSshConnectionTest(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { success: false, stages: [] };
  const result = value as Payload;
  const stages = Array.isArray(result.stages) ? result.stages.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const stage = item as Payload;
    const key = typeof stage.key === "string" ? stage.key : "unknown";
    const status = typeof stage.status === "string" ? stage.status : "failed";
    const rawDetail = typeof stage.detail === "string" ? stage.detail : "";
    const stableCode = rawDetail.split(/\r?\n/).find((line) => /^ssh_[a-z0-9_]+$/.test(line.trim()))?.trim();
    const fingerprint = rawDetail.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0];
    const detail = stableCode
      ?? (key === "client" ? (status === "passed" ? "ssh_client_available" : "ssh_client_unavailable")
        : key === "proxy" ? (status === "passed" ? "ssh_proxy_ready" : "ssh_proxy_failed")
          : status === "passed" ? "ssh_connection_ready" : "ssh_connection_failed");
    return [{ key, status, detail, ...(fingerprint ? { fingerprint } : {}) }];
  }) : [];
  return { success: result.success === true, stages };
}

function sshHostInput(payload: Payload): CreateSshHostInput {
  const authMode = (optionalString(payload, "authMode", 32) ?? "agent") as SshAuthMode;
  if (!SAFE_SSH_AUTH_MODES.has(authMode)) {
    managementError("ssh_sensitive_auth_mode_forbidden", "Web cannot configure identity files or saved credentials");
  }
  const configAlias = optionalString(payload, "configAlias", 255) ?? "";
  return {
    name: requiredString(payload, "name", 255),
    host: configAlias ? "" : requiredString(payload, "host", 255),
    port: numberValue(payload, "port", 22, 1, 65535),
    username: configAlias ? "" : (optionalString(payload, "username", 255) ?? ""),
    config_alias: configAlias,
    auth_mode: configAlias ? "ssh_config" : authMode,
    jump_mode: "none",
    proxy_type: "none",
    connect_timeout_sec: numberValue(payload, "connectTimeoutSec", 15, 1, 300),
    server_alive_interval_sec: numberValue(payload, "serverAliveIntervalSec", 30, 0, 3600),
    server_alive_count_max: numberValue(payload, "serverAliveCountMax", 3, 1, 100),
    terminal_encoding: optionalString(payload, "terminalEncoding", 64) ?? "UTF-8",
  };
}

async function executeSsh(operation: WebDeviceOperation, payload: Payload): Promise<unknown> {
  if (operation.kind === "ssh.client_status") return invoke("ssh_client_status");
  await ensureSshHostsLoaded();
  const store = useSshHostStore.getState();
  if (operation.kind === "ssh.hosts.list") {
    return { hosts: store.hosts.map(publicSshHost), groups: store.groups };
  }
  if (operation.kind === "ssh.host.create") {
    const host = await store.createHost(sshHostInput(payload));
    return publicSshHost(host);
  }
  const hostId = requiredString(payload, "hostId", 128);
  const host = store.hosts.find((item) => item.id === hostId);
  if (!host) managementError("ssh_host_not_found", "SSH host was not found");
  if (operation.kind === "ssh.host.update") {
    const input: UpdateSshHostInput = {};
    if (payload.name !== undefined) input.name = requiredString(payload, "name", 255);
    if (payload.host !== undefined) input.host = requiredString(payload, "host", 255);
    if (payload.port !== undefined) input.port = numberValue(payload, "port", host.port, 1, 65535);
    if (payload.username !== undefined) input.username = requiredString(payload, "username", 255);
    if (payload.configAlias !== undefined) input.config_alias = requiredString(payload, "configAlias", 255);
    if (payload.authMode !== undefined) {
      const authMode = requiredString(payload, "authMode", 32) as SshAuthMode;
      if (!SAFE_SSH_AUTH_MODES.has(authMode)) managementError("ssh_sensitive_auth_mode_forbidden", "Web cannot configure identity files or saved credentials");
      input.auth_mode = authMode;
    }
    if (payload.connectTimeoutSec !== undefined) input.connect_timeout_sec = numberValue(payload, "connectTimeoutSec", host.connect_timeout_sec, 1, 300);
    if (payload.serverAliveIntervalSec !== undefined) input.server_alive_interval_sec = numberValue(payload, "serverAliveIntervalSec", host.server_alive_interval_sec, 0, 3600);
    if (payload.serverAliveCountMax !== undefined) input.server_alive_count_max = numberValue(payload, "serverAliveCountMax", host.server_alive_count_max, 1, 100);
    if (payload.terminalEncoding !== undefined) input.terminal_encoding = requiredString(payload, "terminalEncoding", 64);
    await store.updateHost(hostId, input);
    return publicSshHost(useSshHostStore.getState().hosts.find((item) => item.id === hostId)!);
  }
  if (operation.kind === "ssh.host.delete") {
    await store.deleteHost(hostId);
    return { deleted: true, hostId };
  }
  const spec = buildSshConnectionSpec(host, store.hosts);
  if (operation.kind === "ssh.test_connection") {
    return publicSshConnectionTest(await invoke("ssh_test_connection", { spec, acceptNewHostKey: booleanValue(payload, "acceptNewHostKey") }));
  }
  const path = requiredString(payload, "path");
  if (operation.kind === "ssh.check_path") return invoke("ssh_check_path", { spec, path });
  return invoke("ssh_list_directories", { spec, path });
}

async function executeFile(operation: WebDeviceOperation, payload: Payload): Promise<unknown> {
  const { rootPath } = await resolveLocalContext(payload);
  switch (operation.kind) {
    case "file.list": return invoke("file_list_dir", { rootPath, relativePath: optionalString(payload, "path") ?? "" });
    case "file.search": return invoke("file_search", { rootPath, query: requiredString(payload, "query", 512) });
    case "file.search_content": return invoke("file_search_content", { rootPath, query: requiredString(payload, "query", 512) });
    case "file.create":
      await invoke("file_create_file", { rootPath, parentPath: optionalString(payload, "parentPath") ?? "", name: requiredString(payload, "name", 255), overwrite: booleanValue(payload, "overwrite") });
      break;
    case "file.create_directory":
      await invoke("file_create_dir", { rootPath, parentPath: optionalString(payload, "parentPath") ?? "", name: requiredString(payload, "name", 255), overwrite: booleanValue(payload, "overwrite") });
      break;
    case "file.rename":
      await invoke("file_rename", { rootPath, relativePath: requiredString(payload, "path"), newName: requiredString(payload, "name", 255), overwrite: booleanValue(payload, "overwrite") });
      break;
    case "file.copy":
    case "file.move":
      await invoke(operation.kind === "file.copy" ? "file_copy" : "file_move", { rootPath, sourcePath: requiredString(payload, "sourcePath"), targetParentPath: optionalString(payload, "targetParentPath") ?? "", name: requiredString(payload, "name", 255), overwrite: booleanValue(payload, "overwrite") });
      break;
    case "file.delete":
      await invoke("file_delete", { rootPath, relativePath: requiredString(payload, "path") });
      break;
  }
  return { ok: true };
}

async function executeGit(operation: WebDeviceOperation, payload: Payload): Promise<unknown> {
  const { rootPath } = await resolveLocalContext(payload);
  switch (operation.kind) {
    case "git.status": {
      const [changes, branch] = await Promise.all([
        invoke("git_get_changes", { projectPath: rootPath }),
        invoke("git_branch_status", { projectPath: rootPath }),
      ]);
      return { changes, branch };
    }
    case "git.branches": return invoke("git_list_branches", { projectPath: rootPath });
    case "git.fetch": await invoke("git_fetch", { projectPath: rootPath }); break;
    case "git.checkout": await invoke("git_checkout_branch", { projectPath: rootPath, branch: requiredString(payload, "branch", 255), remote: booleanValue(payload, "remote") }); break;
    case "git.create_branch": await invoke("git_create_branch", { projectPath: rootPath, branch: requiredString(payload, "branch", 255) }); break;
    case "git.stage": await invoke("git_stage_paths", { projectPath: rootPath, paths: stringArray(payload, "paths") }); break;
    case "git.unstage": await invoke("git_unstage_paths", { projectPath: rootPath, paths: stringArray(payload, "paths") }); break;
    case "git.commit": await invoke("git_commit", { projectPath: rootPath, message: requiredString(payload, "message", 16 * 1024) }); break;
    case "git.pull": {
      const strategy = optionalString(payload, "strategy", 32) ?? "ff-only";
      if (!new Set(["merge", "rebase", "ff-only"]).has(strategy)) managementError("invalid_operation_payload", "invalid pull strategy");
      await invoke("git_pull", { projectPath: rootPath, strategy });
      break;
    }
    case "git.push": {
      const branch = await invoke<{ branch: string; hasUpstream: boolean }>("git_branch_status", { projectPath: rootPath });
      await invoke("git_push", { projectPath: rootPath, setUpstream: !branch.hasUpstream, branch: branch.hasUpstream ? null : branch.branch });
      break;
    }
    case "git.discard": {
      const items = payload.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > 500) managementError("invalid_operation_payload", "items is invalid");
      for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) managementError("invalid_operation_payload", "discard item is invalid");
        const record = item as Payload;
        await invoke("git_discard_file", { projectPath: rootPath, filePath: requiredString(record, "path"), status: requiredString(record, "status", 8) });
      }
      break;
    }
    case "git.delete_untracked": await invoke("git_delete_untracked_paths", { projectPath: rootPath, paths: stringArray(payload, "paths") }); break;
  }
  return { ok: true };
}

function requireWorktree(payload: Payload, project: Project): WorktreeRecord {
  const id = requiredString(payload, "worktreeId", 128);
  const worktree = useProjectStore.getState().worktrees.find((item) => item.id === id && item.project_id === project.id);
  if (!worktree) managementError("worktree_not_found", "Worktree was not found");
  return worktree;
}

function publicWorktree(worktree: WorktreeRecord) {
  return {
    id: worktree.id,
    name: worktree.name,
    branch: worktree.branch,
    baseBranch: worktree.base_branch,
    status: worktree.status,
    createdAt: worktree.created_at,
    updatedAt: worktree.updated_at,
  };
}

function publicHookStatus(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const status = value as Payload;
  const tool = (key: "claude" | "codex") => {
    const item = status[key];
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const source = item as Payload;
    return {
      status: source.status,
      attentionScriptInstalled: source.attentionScriptInstalled,
      finishedScriptInstalled: source.finishedScriptInstalled,
      sessionStartHookInstalled: source.sessionStartHookInstalled,
      runningHookInstalled: source.runningHookInstalled,
      attentionHookInstalled: source.attentionHookInstalled,
      stopHookInstalled: source.stopHookInstalled,
      failureHookInstalled: source.failureHookInstalled,
      subagentStartHookInstalled: source.subagentStartHookInstalled,
      hooksFeatureInstalled: source.hooksFeatureInstalled,
    };
  };
  const ccSwitch = status.ccSwitch;
  const ccSwitchSource = ccSwitch && typeof ccSwitch === "object" && !Array.isArray(ccSwitch) ? ccSwitch as Payload : null;
  return {
    claude: tool("claude"),
    codex: tool("codex"),
    ccSwitch: ccSwitchSource ? { state: ccSwitchSource.state, wslMismatch: ccSwitchSource.wslMismatch } : null,
    claudeAutoRepaired: status.claudeAutoRepaired,
  };
}

async function executeWorktree(operation: WebDeviceOperation, payload: Payload): Promise<unknown> {
  const { project } = await resolveLocalContext(payload);
  if (operation.kind === "worktree.list") {
    return useProjectStore.getState().worktrees.filter((item) => item.project_id === project.id).map(publicWorktree);
  }
  const store = useWorktreeStore.getState();
  if (!store.loaded) await store.loadWorktrees();
  if (operation.kind === "worktree.create") return publicWorktree(await store.createWorktreeForProject(project, requiredString(payload, "taskName", 64)));
  const worktree = requireWorktree(payload, project);
  if (operation.kind === "worktree.check_deps") return store.checkDeps(worktree);
  if (operation.kind === "worktree.merge") {
    const result = await store.mergeWorktree(worktree);
    return {
      merged: result.merged,
      conflictFiles: result.conflictFiles,
      skipped: result.skipped,
      skipReason: result.skipReason,
    };
  }
  await store.removeWorktree(worktree, booleanValue(payload, "deleteBranch"));
  return { removed: true, worktreeId: worktree.id };
}

async function executeHook(operation: WebDeviceOperation, payload: Payload): Promise<unknown> {
  const settings = useSettingsStore.getState();
  const target = optionalString(payload, "target", 16) ?? "all";
  if (!new Set(["claude", "codex", "all"]).has(target)) managementError("invalid_operation_payload", "invalid Hook target");
  const args = {
    selectedDir: settings.claudeHookConfigDir?.trim() || undefined,
    codexSelectedDir: settings.codexHookConfigDir?.trim() || undefined,
    ccSwitchDbPath: settings.ccSwitchDbPath ?? undefined,
  };
  if (operation.kind === "hook.status" || operation.kind === "hook.test") {
    const status = await invoke<Record<string, unknown>>("hook_settings_get_status", { ...args, autoRepair: false });
    if (operation.kind === "hook.test") {
      const installed = (tool: "claude" | "codex") => {
        const value = status[tool];
        return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Payload).status === "installed");
      };
      const success = target === "all" ? installed("claude") && installed("codex") : installed(target as "claude" | "codex");
      if (!success) managementError("hook_test_failed", "the selected Hook is not fully installed");
      return { success, testedAt: Date.now(), status: publicHookStatus(status) };
    }
    return publicHookStatus(status);
  }
  const install = operation.kind === "hook.install" || operation.kind === "hook.repair";
  const results: Record<string, unknown> = {};
  if (target === "claude" || target === "all") {
    results.claude = publicHookStatus(await invoke(install ? "hook_settings_install" : "hook_settings_uninstall", args));
  }
  if (target === "codex" || target === "all") {
    results.codex = publicHookStatus(await invoke(install ? "hook_settings_install_codex" : "hook_settings_uninstall_codex", args));
  }
  return results;
}

export async function validateWebManagementOperation(operation: WebDeviceOperation): Promise<void> {
  if (!isWebManagementOperation(operation.kind)) managementError("unsupported_operation_kind", `unsupported operation kind: ${operation.kind}`);
  const payload = payloadObject(operation);
  requireConfirmation(operation, payload);

  if (operation.kind.startsWith("ssh.")) {
    if (operation.kind === "ssh.client_status") return;
    await ensureSshHostsLoaded();
    if (operation.kind === "ssh.hosts.list") return;
    if (operation.kind === "ssh.host.create") {
      sshHostInput(payload);
      return;
    }
    const hostId = requiredString(payload, "hostId", 128);
    const host = useSshHostStore.getState().hosts.find((item) => item.id === hostId);
    if (!host) managementError("ssh_host_not_found", "SSH host was not found");
    if (operation.kind === "ssh.host.update") {
      if (payload.name !== undefined) requiredString(payload, "name", 255);
      if (payload.host !== undefined) requiredString(payload, "host", 255);
      if (payload.port !== undefined) numberValue(payload, "port", host.port, 1, 65535);
      if (payload.username !== undefined) requiredString(payload, "username", 255);
      if (payload.configAlias !== undefined) requiredString(payload, "configAlias", 255);
      if (payload.authMode !== undefined && !SAFE_SSH_AUTH_MODES.has(requiredString(payload, "authMode", 32) as SshAuthMode)) {
        managementError("ssh_sensitive_auth_mode_forbidden", "Web cannot configure identity files or saved credentials");
      }
      return;
    }
    if (operation.kind === "ssh.check_path" || operation.kind === "ssh.list_directories") requiredString(payload, "path");
    return;
  }

  if (operation.kind.startsWith("file.")) {
    await resolveLocalContext(payload);
    switch (operation.kind) {
      case "file.search":
      case "file.search_content": requiredString(payload, "query", 512); break;
      case "file.create":
      case "file.create_directory": requiredString(payload, "name", 255); break;
      case "file.rename": requiredString(payload, "path"); requiredString(payload, "name", 255); break;
      case "file.copy":
      case "file.move": requiredString(payload, "sourcePath"); requiredString(payload, "name", 255); break;
      case "file.delete": requiredString(payload, "path"); break;
    }
    return;
  }

  if (operation.kind.startsWith("git.")) {
    await resolveLocalContext(payload);
    switch (operation.kind) {
      case "git.checkout":
      case "git.create_branch": requiredString(payload, "branch", 255); break;
      case "git.stage":
      case "git.unstage":
      case "git.delete_untracked": stringArray(payload, "paths"); break;
      case "git.commit": requiredString(payload, "message", 16 * 1024); break;
      case "git.pull": {
        const strategy = optionalString(payload, "strategy", 32) ?? "ff-only";
        if (!new Set(["merge", "rebase", "ff-only"]).has(strategy)) managementError("invalid_operation_payload", "invalid pull strategy");
        break;
      }
      case "git.discard": {
        const items = payload.items;
        if (!Array.isArray(items) || items.length === 0 || items.length > 500) managementError("invalid_operation_payload", "items is invalid");
        for (const item of items) {
          if (!item || typeof item !== "object" || Array.isArray(item)) managementError("invalid_operation_payload", "discard item is invalid");
          requiredString(item as Payload, "path");
          requiredString(item as Payload, "status", 8);
        }
        break;
      }
    }
    return;
  }

  if (operation.kind.startsWith("worktree.")) {
    const { project } = await resolveLocalContext(payload);
    if (operation.kind === "worktree.list") return;
    const store = useWorktreeStore.getState();
    if (!store.loaded) await store.loadWorktrees();
    if (operation.kind === "worktree.create") requiredString(payload, "taskName", 64);
    else requireWorktree(payload, project);
    return;
  }

  const target = optionalString(payload, "target", 16) ?? "all";
  if (!new Set(["claude", "codex", "all"]).has(target)) managementError("invalid_operation_payload", "invalid Hook target");
}

export function isWebManagementOperation(kind: string): boolean {
  return MANAGEMENT_KINDS.has(kind);
}

export function webManagementOperationNeedsConfirmation(operation: WebDeviceOperation): boolean {
  if (CONFIRMED_KINDS.has(operation.kind)) return true;
  const payload = operation.payload;
  return operation.kind === "ssh.test_connection"
    && Boolean(payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Payload).acceptNewHostKey === true);
}

export async function executeWebManagementOperation(operation: WebDeviceOperation, validated = false): Promise<unknown> {
  if (!validated) await validateWebManagementOperation(operation);
  const payload = payloadObject(operation);
  if (operation.kind.startsWith("ssh.")) return executeSsh(operation, payload);
  if (operation.kind.startsWith("file.")) return executeFile(operation, payload);
  if (operation.kind.startsWith("git.")) return executeGit(operation, payload);
  if (operation.kind.startsWith("worktree.")) return executeWorktree(operation, payload);
  return executeHook(operation, payload);
}
