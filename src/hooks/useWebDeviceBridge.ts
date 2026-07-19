import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { confirm as confirmNative } from "@tauri-apps/plugin-dialog";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useTerminalStore } from "../stores/terminalStore";
import type { CliHookPayload } from "../stores/terminalStore";
import { terminalProcessManager } from "../terminal/core/TerminalProcessManager";
import { findProjectByPath, findWorktreeByPath, normalizeProjectPath, projectWithWorktreeProviderOverrides } from "../lib/terminalProject";
import { appendResumeCliArgs, resolveProjectStartupCommand } from "../lib/projectStartupCommand";
import { getProviderSwitchAppType } from "../lib/providerSwitching";
import { logWarn } from "../lib/logger";
import { translateCurrent } from "../lib/i18n";
import { webDeviceApi, type WebDeviceOperation, type WebHistorySessionSummary } from "../lib/webDevice";
import {
  executeWebManagementOperation,
  isWebManagementOperation,
  validateWebManagementOperation,
  webManagementOperationNeedsConfirmation,
} from "../lib/webManagement";

const OPERATION_EVENT = "web-device-operation-ready";
const OPERATION_POLL_MS = 1_000;
const HISTORY_PUBLISH_MS = 60_000;
const CLI_START_TIMEOUT_MS = 60_000;
const OPERATION_TIMEOUT_MS = 30 * 60_000;
const MAX_PROMPT_LENGTH = 64 * 1024;
const OPERATION_FRAME_RETRY_MS = 1_000;

type CliSource = "claude" | "codex";

interface OperationPayload {
  prompt: string;
  source: CliSource;
  projectKey: string;
  cwd: string;
  sessionId?: string;
}

interface ActiveOperation {
  operationId: string;
  tabId: string;
  prompt: string;
  promptSent: boolean;
  cliSessionId: string | null;
  startupTimer: ReturnType<typeof setTimeout>;
  completionTimer: ReturnType<typeof setTimeout>;
}

const activeByTab = new Map<string, ActiveOperation>();
const activeOperationIds = new Set<string>();
let drainingOperations = false;

function operationError(code: string, message: string) {
  return { code, message };
}

function operationApprovalTarget(operation: WebDeviceOperation): string {
  if (!operation.payload || typeof operation.payload !== "object" || Array.isArray(operation.payload)) return "-";
  const payload = operation.payload as Record<string, unknown>;
  const keys = ["projectKey", "cwd", "hostId", "path", "sourcePath", "targetParentPath", "branch", "worktreeId", "target", "name"];
  const details = keys.flatMap((key) => {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return [`${key}: ${value.trim()}`];
    if (Array.isArray(value) && value.length > 0) return [`${key}: ${value.map(String).join(", ")}`];
    return [];
  });
  return details.join("\n") || "-";
}

function parsePayload(operation: WebDeviceOperation): OperationPayload {
  if (!operation.payload || typeof operation.payload !== "object" || Array.isArray(operation.payload)) {
    throw operationError("invalid_operation_payload", "operation payload must be an object");
  }
  const payload = operation.payload as Record<string, unknown>;
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  const source = payload.source === "claude" || payload.source === "codex" ? payload.source : null;
  const projectKey = typeof payload.projectKey === "string" ? payload.projectKey.trim() : "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : undefined;
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH || /[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)) {
    throw operationError("invalid_prompt", "prompt is empty, too long, or contains control characters");
  }
  if (!source || !projectKey || !cwd) {
    throw operationError("project_context_required", "source, projectKey and cwd are required");
  }
  if (operation.kind === "conversation.prompt" && (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId))) {
    throw operationError("invalid_session_id", "conversation.prompt requires a valid sessionId");
  }
  return { prompt, source, projectKey, cwd, sessionId };
}

async function hasRequiredHook(source: CliSource): Promise<boolean> {
  const settings = useSettingsStore.getState();
  const status = await invoke<{ claude: { status: string }; codex: { status: string } }>("hook_settings_get_status", {
    selectedDir: settings.claudeHookConfigDir?.trim() || null,
    codexSelectedDir: settings.codexHookConfigDir?.trim() || null,
    ccSwitchDbPath: settings.ccSwitchDbPath ?? undefined,
    autoRepair: settings.claudeHookBridgeEnabled && settings.claudeHookAutoRepairKnownInstalled,
  });
  return source === "claude"
    ? settings.claudeHookBridgeEnabled && status.claude.status === "installed"
    : settings.codexHookBridgeEnabled && status.codex.status === "installed";
}

function resumeCommand(source: CliSource, sessionId: string, project: ReturnType<typeof projectWithWorktreeProviderOverrides>): string {
  const base = source === "claude" ? `claude --resume ${sessionId}` : `codex resume ${sessionId}`;
  return appendResumeCliArgs(base, source, project);
}

async function finishOperation(
  active: ActiveOperation,
  status: "succeeded" | "failed" | "rejected" | "timed_out",
  result: unknown,
  error: { code: string; message: string } | null,
) {
  clearTimeout(active.startupTimer);
  clearTimeout(active.completionTimer);
  await reportCompletion(active.operationId, status, result, error);
  activeByTab.delete(active.tabId);
  activeOperationIds.delete(active.operationId);
}

async function rejectBeforeExecution(operationId: string, code: string, message: string) {
  await reportCompletion(operationId, "rejected", null, operationError(code, message));
  activeOperationIds.delete(operationId);
}

function waitForOperationFrameRetry() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, OPERATION_FRAME_RETRY_MS));
}

async function reportCompletion(
  operationId: string,
  status: "succeeded" | "failed" | "rejected" | "timed_out",
  result: unknown,
  error: { code: string; message: string } | null,
) {
  for (;;) {
    try {
      await webDeviceApi.completed(operationId, status, result, error);
      return;
    } catch (caught) {
      logWarn("Failed to complete Web device operation; retrying", { operationId, caught });
      await waitForOperationFrameRetry();
    }
  }
}

function isManagementRejection(code: string) {
  return code.startsWith("invalid_")
    || code.endsWith("_required")
    || code.endsWith("_forbidden")
    || code.endsWith("_not_found")
    || code.endsWith("_unsupported")
    || code === "path_outside_root"
    || code === "target_exists"
    || code === "worktree_missing"
    || code === "history_context_not_found";
}

async function executeOperation(operation: WebDeviceOperation) {
  if (activeOperationIds.has(operation.id)) return;
  if (["succeeded", "failed", "rejected", "timed_out", "canceled"].includes(operation.status)) return;
  activeOperationIds.add(operation.id);

  let payload: OperationPayload;
  let executionStarted = false;
  const managementOperation = isWebManagementOperation(operation.kind);
  try {
    if (operation.status === "accepted" || operation.status === "running") {
      if (operation.status === "accepted") await webDeviceApi.running(operation.id);
      await reportCompletion(
        operation.id,
        "failed",
        null,
        operationError("operation_interrupted", "desktop execution was interrupted before completion"),
      );
      activeOperationIds.delete(operation.id);
      return;
    }
    if (managementOperation) {
      await validateWebManagementOperation(operation);
      if (webManagementOperationNeedsConfirmation(operation)) {
        const confirmed = await confirmNative(
          translateCurrent("settings.webDevice.operationApproval.message", {
            kind: operation.kind,
            target: operationApprovalTarget(operation),
          }),
          {
            title: translateCurrent("settings.webDevice.operationApproval.title"),
            kind: "warning",
          },
        );
        if (!confirmed) throw operationError("operation_rejected_by_user", "desktop user rejected the operation");
      }
      await webDeviceApi.accepted(operation.id);
      await webDeviceApi.running(operation.id);
      executionStarted = true;
      const result = await executeWebManagementOperation(operation, true);
      await reportCompletion(operation.id, "succeeded", result, null);
      activeOperationIds.delete(operation.id);
      return;
    }
    if (operation.kind !== "conversation.start" && operation.kind !== "conversation.prompt") {
      throw operationError("unsupported_operation_kind", `unsupported operation kind: ${operation.kind}`);
    }
    payload = parsePayload(operation);
    if (!(await hasRequiredHook(payload.source))) {
      throw operationError("cli_hook_required", `${payload.source} hook is not installed or enabled`);
    }

    const projectStore = useProjectStore.getState();
    if (!projectStore.loaded) await projectStore.fetchAll("startup");
    const historyStore = useHistoryStore.getState();
    await historyStore.loadSessions();
    const matchesHistoryContext = useHistoryStore.getState().sessions.some((session) => (
      session.source === payload.source
      && session.project_key === payload.projectKey
      && normalizeProjectPath(session.cwd?.trim() || "") === normalizeProjectPath(payload.cwd)
      && (operation.kind !== "conversation.prompt" || session.session_id === payload.sessionId)
    ));
    if (!matchesHistoryContext) {
      throw operationError("history_context_not_found", "operation context does not match desktop history");
    }
    const { projects, worktrees } = useProjectStore.getState();
    const worktree = findWorktreeByPath(worktrees, payload.cwd);
    const project = worktree
      ? projects.find((item) => item.id === worktree.project_id) ?? null
      : findProjectByPath(projects, payload.cwd);
    if (!project) throw operationError("project_not_found", "desktop project context was not found");
    if (project.environment_type === "ssh") throw operationError("ssh_not_supported", "SSH projects are not supported by Web P0");
    if (worktree?.status === "missing") throw operationError("worktree_missing", "target Worktree no longer exists");
    if (getProviderSwitchAppType(project) !== payload.source) {
      throw operationError("cli_source_mismatch", "project CLI does not match the requested history source");
    }
    await webDeviceApi.validateContext(worktree?.path ?? project.path, payload.cwd);

    const launchProject = worktree ? projectWithWorktreeProviderOverrides(project, worktree) : project;
    const startupCommand = operation.kind === "conversation.prompt"
      ? resumeCommand(payload.source, payload.sessionId!, launchProject)
      : resolveProjectStartupCommand(launchProject);
    if (!startupCommand) throw operationError("cli_not_configured", "project CLI startup command is not configured");

    await webDeviceApi.accepted(operation.id);
    await webDeviceApi.running(operation.id);
    executionStarted = true;
    const tabId = await useTerminalStore.getState().createSession(
      project.id,
      payload.cwd,
      launchProject.name,
      startupCommand,
      undefined,
      launchProject.shell || undefined,
      undefined,
      worktree?.id,
    );
    const active: ActiveOperation = {
      operationId: operation.id,
      tabId,
      prompt: payload.prompt,
      promptSent: false,
      cliSessionId: null,
      startupTimer: setTimeout(() => {
        const current = activeByTab.get(tabId);
        if (current) void finishOperation(current, "failed", null, operationError("cli_start_timeout", "CLI did not report SessionStart in time"));
      }, CLI_START_TIMEOUT_MS),
      completionTimer: setTimeout(() => {
        const current = activeByTab.get(tabId);
        if (current) void finishOperation(current, "timed_out", null, operationError("operation_timed_out", "CLI operation exceeded the desktop time limit"));
      }, OPERATION_TIMEOUT_MS),
    };
    activeByTab.set(tabId, active);
  } catch (caught) {
    const error = caught && typeof caught === "object" && "code" in caught && "message" in caught
      ? caught as { code: string; message: string }
      : operationError("operation_failed", String(caught));
    if (executionStarted) {
      const status = managementOperation && isManagementRejection(error.code) ? "rejected" : "failed";
      await reportCompletion(operation.id, status, null, error);
      activeOperationIds.delete(operation.id);
    } else {
      await rejectBeforeExecution(operation.id, error.code, error.message);
    }
  }
}

async function drainOperations() {
  if (drainingOperations) return;
  drainingOperations = true;
  try {
    const operations = await webDeviceApi.takeOperations();
    for (const operation of operations) await executeOperation(operation);
  } catch (caught) {
    logWarn("Failed to drain Web device operations", caught);
  } finally {
    drainingOperations = false;
  }
}

async function publishHistory() {
  try {
    const historyStore = useHistoryStore.getState();
    await historyStore.loadSessions();
    const status = await webDeviceApi.getStatus();
    if (!status.paired || !status.connected || !status.profile) return;
    const sessions: WebHistorySessionSummary[] = useHistoryStore.getState().sessions.map((session) => ({
      sessionId: session.session_id,
      deviceId: status.profile!.deviceId,
      source: session.source,
      projectKey: session.project_key,
      title: session.displayTitle || session.title,
      cwd: session.cwd?.trim() || null,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      messageCount: session.message_count,
      branch: session.branch ?? null,
      freshness: "live",
    }));
    await webDeviceApi.publishHistory(sessions);
  } catch (caught) {
    logWarn("Failed to publish Web device history", caught);
  }
}

export function handleWebDeviceCliHook(payload: CliHookPayload, tabId: string | null) {
  if (!tabId) return;
  const active = activeByTab.get(tabId);
  if (!active) return;
  if (payload.sessionId?.trim()) active.cliSessionId = payload.sessionId.trim();

  if (payload.event === "SessionStart" && !active.promptSent) {
    active.promptSent = true;
    clearTimeout(active.startupTimer);
    void terminalProcessManager.write(tabId, `${active.prompt.replace(/\r\n?/g, "\n")}\r`).catch((caught) => {
      void finishOperation(active, "failed", null, operationError("prompt_write_failed", String(caught)));
    });
    return;
  }
  if (payload.event === "Stop") {
    void finishOperation(active, "succeeded", { tabId, sessionId: active.cliSessionId }, null);
  } else if (payload.event === "StopFailure") {
    void finishOperation(active, "failed", { tabId, sessionId: active.cliSessionId }, operationError("cli_stop_failure", payload.message || "CLI reported failure"));
  }
}

export function useWebDeviceBridge(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const unlisten = listen(OPERATION_EVENT, () => void drainOperations());
    void drainOperations();
    void publishHistory();
    const operationTimer = window.setInterval(() => void drainOperations(), OPERATION_POLL_MS);
    const historyTimer = window.setInterval(() => void publishHistory(), HISTORY_PUBLISH_MS);
    return () => {
      window.clearInterval(operationTimer);
      window.clearInterval(historyTimer);
      void unlisten.then((dispose) => dispose());
    };
  }, [ready]);
}
