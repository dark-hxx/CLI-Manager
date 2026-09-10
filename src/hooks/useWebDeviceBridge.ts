import { buildWebSubagentSnapshots } from "../lib/webSubagentSnapshot";
import { useEffect } from "react";
import { publishWebTerminalBatch } from "../lib/webTerminalBackpressure";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { confirm as confirmNative } from "@tauri-apps/plugin-dialog";
import { fetchLatestProjectSessionDetail, useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
import { hasVisibleDesktopViewport, restoreDesktopViewportSize } from "../lib/terminalSizeOwnership";
import { useTerminalStore } from "../stores/terminalStore";
import { PtyHostSocket, type TerminalBinaryFrame } from "../terminal/transport/PtyHostSocket";
import { normalizeProjectPath, projectWithWorktreeProviderOverrides } from "../lib/terminalProject";
import { resolveProjectPath } from "../lib/groupPath";
import { resolveProjectStartupCommand } from "../lib/projectStartupCommand";
import { parseWebConversationLaunch } from "../lib/webConversationLaunch";
import { getProviderSwitchAppType } from "../lib/providerSwitching";
import { logWarn } from "../lib/logger";
import { getCurrentLanguage, translateCurrent } from "../lib/i18n";
import { getHistoryPathArgsSync } from "../lib/historyPathArgs";
import { batchWebTerminalFrames } from "../lib/webTerminalFrames";
import { startWebBridgePolling } from "../lib/webBridgePolling";
import {
  webDeviceApi,
  type WebHistorySessionSummary,
  type WebDeviceOperation,
  type WebDeviceStatus,
  type WebTerminalCommand,
  type WebWorkspaceSnapshot,
} from "../lib/webDevice";
import {
  executeWebManagementOperation,
  isWebManagementOperation,
  validateWebManagementOperation,
  webManagementOperationNeedsConfirmation,
} from "../lib/webManagement";

const OPERATION_EVENT = "web-device-operation-ready";
const WORKSPACE_PUBLISH_MS = 60_000;
const MAX_PROMPT_LENGTH = 64 * 1024;
const OPERATION_FRAME_RETRY_MS = 1_000;
const MAX_COMPLETION_REPORT_ATTEMPTS = 30;
const STATUS_EVENT = "web-device-status-changed";

type CliSource = "claude" | "codex";

interface OperationPayload {
  prompt: string;
  source: CliSource;
  projectId: string;
  worktreeId?: string;
  sessionId?: string;
}

const activeOperationIds = new Set<string>();
let drainingOperations = false;
let webHistoryLoaded = false;
type WebTerminalControlMode = "desktop" | "web";

interface WebTerminalBridge {
  socket: PtyHostSocket;
  output: () => void;
  restartOutput: () => void;
  status: () => void;
  controlMode: WebTerminalControlMode;
  terminalStatus: string;
  exitCode: number | null;
}

const terminalBridges = new Map<string, WebTerminalBridge>();
let drainingTerminalCommands = false;
const terminalOutputSequences = new Map<string, number>();

function terminalControlMode(sessionId: string): WebTerminalControlMode {
  return hasVisibleDesktopViewport(sessionId) ? "desktop" : "web";
}

function isMissingTerminalSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /session .* not found/i.test(message) || /terminal session .* not found/i.test(message);
}

function publishTerminalBridgeStatus(sessionId: string, bridge: WebTerminalBridge): Promise<void> {
  return webDeviceApi.terminalStatus(
    sessionId,
    bridge.terminalStatus,
    bridge.exitCode,
    bridge.controlMode,
  );
}

async function syncTerminalControlModes() {
  for (const [sessionId, bridge] of terminalBridges) {
    const nextMode = terminalControlMode(sessionId);
    if (nextMode === bridge.controlMode) continue;
    bridge.controlMode = nextMode;
    if (nextMode === "desktop") restoreDesktopViewportSize(sessionId);
    await publishTerminalBridgeStatus(sessionId, bridge);
  }
}

async function attachWebTerminal(sessionId: string, afterSequence?: number) {
  const existing = terminalBridges.get(sessionId);
  if (existing) {
    existing.restartOutput();
    existing.controlMode = terminalControlMode(sessionId);
    const attached = await existing.socket.attach(sessionId, afterSequence === undefined, afterSequence);
    existing.terminalStatus = attached.attached && attached.alive ? "running" : attached.attached ? "exited" : "error";
    await publishTerminalBridgeStatus(sessionId, existing);
    return;
  }
  if (!useTerminalStore.getState().sessions.some((session) => session.id === sessionId)) {
    await webDeviceApi.terminalStatus(sessionId, "error");
    return;
  }
  let pendingFrames: TerminalBinaryFrame[] = [];
  let flushTimer: number | null = null;
  let publishQueue = Promise.resolve();
  let outputGeneration = 0;
  let outputFailed = false;
  const socket = new PtyHostSocket();
  const flush = () => {
    flushTimer = null;
    const frames = pendingFrames;
    pendingFrames = [];
    if (frames.length === 0) return;
    const generation = outputGeneration;
    for (const batch of batchWebTerminalFrames(frames, useSettingsStore.getState().webTerminalBatchKiB)) {
      const sequence = (terminalOutputSequences.get(sessionId) ?? 0) + 1;
      terminalOutputSequences.set(sessionId, sequence);
      publishQueue = publishQueue.then(async () => {
        if (generation !== outputGeneration || outputFailed) return;
        const accepted = await publishWebTerminalBatch(
          () => webDeviceApi.terminalOutput(sessionId, sequence, batch.frames),
          () => generation === outputGeneration && !outputFailed,
        );
        if (accepted && generation === outputGeneration) {
          for (const ack of batch.acknowledgements) {
            socket.acknowledge(sessionId, ack.sequence, ack.bytes);
          }
        }
      }).catch((error) => {
        if (generation !== outputGeneration) return;
        outputFailed = true;
        bridge.terminalStatus = "error";
        logWarn("Failed to publish Web terminal output", error);
        void webDeviceApi.terminalStatus(sessionId, "error").catch((caught) => logWarn("Failed to report Web terminal output error", caught));
      });
    }
  };
  await socket.connect();
  const unsubscribeOutput = socket.subscribeOutput(sessionId, (frame) => {
    if (outputFailed) return;
    pendingFrames.push(frame);
    if (flushTimer === null) flushTimer = window.setTimeout(flush, 16);
  });
  const restartOutput = () => {
    outputGeneration += 1;
    outputFailed = false;
    if (flushTimer !== null) window.clearTimeout(flushTimer);
    flushTimer = null;
    pendingFrames = [];
  };
  const output = () => {
    unsubscribeOutput();
    restartOutput();
    outputFailed = true;
  };
  const bridge: WebTerminalBridge = {
    socket,
    output,
    restartOutput,
    status: () => undefined,
    controlMode: terminalControlMode(sessionId),
    terminalStatus: "connecting",
    exitCode: null,
  };
  const status = socket.subscribeStatus(sessionId, (event) => {
    bridge.terminalStatus = event.status;
    bridge.exitCode = event.exit_code;
    void publishTerminalBridgeStatus(sessionId, bridge);
  });
  bridge.status = status;
  terminalBridges.set(sessionId, bridge);
  const attached = await socket.attach(sessionId, afterSequence === undefined, afterSequence);
  if (!attached.attached) {
    output(); status(); socket.dispose(); terminalBridges.delete(sessionId);
    await webDeviceApi.terminalStatus(sessionId, "error");
    return;
  }
  bridge.terminalStatus = attached.alive ? "running" : "exited";
  await publishTerminalBridgeStatus(sessionId, bridge);
}

async function executeTerminalCommand(command: WebTerminalCommand) {
  if (command.type === "attach") return attachWebTerminal(command.sessionId, command.afterSequence);
  if (command.type === "detach") {
    const bridge = terminalBridges.get(command.sessionId);
    bridge?.output(); bridge?.status(); bridge?.socket.dispose(); terminalBridges.delete(command.sessionId);
    return;
  }
  if (command.type === "close") {
    const bridge = terminalBridges.get(command.sessionId);
    let closeStatus: "exited" | "error" = "exited";
    try {
      // Web close is global: terminate the real PTY so the desktop terminal
      // observes the same lifecycle transition.
      // Reuse the desktop store action so its tab/workspan/persistence state
      // is removed together with the PTY, including stale-session recovery.
      const hasDesktopSession = useTerminalStore.getState().sessions.some((session) => session.id === command.sessionId);
      if (hasDesktopSession) {
        await useTerminalStore.getState().closeSession(command.sessionId);
      }
      const stillOpen = useTerminalStore.getState().sessions.some((session) => session.id === command.sessionId);
      closeStatus = stillOpen ? "error" : "exited";
      await webDeviceApi.terminalStatus(command.sessionId, closeStatus, null, "desktop");
    } catch (error) {
      if (isMissingTerminalSessionError(error)) {
        await webDeviceApi.terminalStatus(command.sessionId, "exited", null, "desktop");
        return;
      }
      closeStatus = "error";
      logWarn("Failed to close Web terminal session", error);
      await webDeviceApi.terminalStatus(command.sessionId, "error").catch((caught) => logWarn("Failed to report Web terminal close error", caught));
    } finally {
      bridge?.output();
      bridge?.status();
      bridge?.socket.dispose();
      terminalBridges.delete(command.sessionId);
    }
    return;
  }
  const bridge = terminalBridges.get(command.sessionId);
  if (!bridge) return;
  if (command.type === "input") await bridge.socket.write(command.sessionId, command.data);
  if (command.type === "resize") {
    const nextMode = terminalControlMode(command.sessionId);
    if (nextMode !== bridge.controlMode) {
      bridge.controlMode = nextMode;
      if (nextMode === "desktop") restoreDesktopViewportSize(command.sessionId);
      await publishTerminalBridgeStatus(command.sessionId, bridge);
    }
    if (!hasVisibleDesktopViewport(command.sessionId)) {
      await bridge.socket.resize(command.sessionId, command.cols, command.rows);
    }
  }
}

async function drainTerminalCommands() {
  if (drainingTerminalCommands) return;
  drainingTerminalCommands = true;
  try {
    const commands = await webDeviceApi.takeTerminalCommands();
    for (const command of commands) await executeTerminalCommand(command);
    await syncTerminalControlModes();
  } catch (error) {
    logWarn("Failed to drain Web terminal commands", error);
  } finally {
    drainingTerminalCommands = false;
  }
}

function operationError(code: string, message: string) {
  return { code, message };
}

function operationApprovalTarget(operation: WebDeviceOperation): string {
  if (!operation.payload || typeof operation.payload !== "object" || Array.isArray(operation.payload)) return "-";
  const payload = operation.payload as Record<string, unknown>;
  const keys = ["projectId", "worktreeId", "hostId", "path", "sourcePath", "targetParentPath", "branch", "target", "name"];
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
  const projectId = typeof payload.projectId === "string" ? payload.projectId.trim() : "";
  const worktreeId = typeof payload.worktreeId === "string" ? payload.worktreeId.trim() : undefined;
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : undefined;
  if (operation.kind !== "conversation.history" && (!prompt || prompt.length > MAX_PROMPT_LENGTH || /[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt))) {
    throw operationError("invalid_prompt", "prompt is empty, too long, or contains control characters");
  }
  if (!source || !projectId) {
    throw operationError("project_context_required", "source and projectId are required");
  }
  if (operation.kind !== "conversation.start" && (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId))) {
    throw operationError("invalid_session_id", "conversation.prompt requires a valid sessionId");
  }
  return { prompt, source, projectId, worktreeId, sessionId };
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
  for (let attempt = 1; attempt <= MAX_COMPLETION_REPORT_ATTEMPTS; attempt += 1) {
    try {
      await webDeviceApi.completed(operationId, status, result, error);
      return;
    } catch (caught) {
      if (attempt === MAX_COMPLETION_REPORT_ATTEMPTS) {
        logWarn("Failed to complete Web device operation after bounded retries", {
          operationId,
          attempts: attempt,
          caught,
        });
        return;
      }
      logWarn("Failed to complete Web device operation; retrying", {
        operationId,
        attempt,
        caught,
      });
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
    || code.endsWith("_conflict")
    || code === "path_outside_root"
    || code === "target_exists"
    || code === "worktree_missing"
    || code === "desktop_ui_unavailable"
    || code === "unsupported_operation_action"
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
      if (!managementOperation && await invoke<boolean>("web_conversation_is_running", { operationId: operation.id })) {
        activeOperationIds.delete(operation.id);
        return;
      }
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
    if (!["conversation.start", "conversation.prompt", "conversation.history"].includes(operation.kind)) {
      throw operationError("unsupported_operation_kind", `unsupported operation kind: ${operation.kind}`);
    }
    payload = parsePayload(operation);

    const projectStore = useProjectStore.getState();
    if (!projectStore.loaded) await projectStore.fetchAll("startup");
    const { projects, worktrees } = useProjectStore.getState();
    const project = projects.find((item) => item.id === payload.projectId);
    if (!project) throw operationError("project_not_found", "desktop project context was not found");
    const worktree = payload.worktreeId
      ? worktrees.find((item) => item.id === payload.worktreeId && item.project_id === project.id) ?? null
      : null;
    if (payload.worktreeId && !worktree) throw operationError("worktree_not_found", "desktop Worktree context was not found");
    if (worktree?.status === "missing") throw operationError("worktree_missing", "target Worktree no longer exists");
    const resolvedCwd = worktree?.path ?? (project.environment_type === "ssh" ? project.remote_path : project.path);
    if (!resolvedCwd?.trim()) throw operationError("project_path_required", "project path is not configured");
    if (project.environment_type === "ssh") throw operationError("ssh_not_supported", "SSH projects are not supported by Web P0");
    if (getProviderSwitchAppType(project) !== payload.source) {
      throw operationError("cli_source_mismatch", "project CLI does not match the requested source");
    }
    if (operation.kind !== "conversation.start") {
      const terminals = useTerminalStore.getState();
      if (operation.kind === "conversation.prompt" && terminals.sessions.some((session) => session.cliSessionId === payload.sessionId
        && terminals.sessionStatuses[session.id] === "running")) {
        throw operationError("conversation_owned_by_terminal", "Close the active desktop CLI session before resuming it on the Web.");
      }
      const matchedHistory = await fetchLatestProjectSessionDetail(
        resolvedCwd,
        undefined,
        payload.source,
        payload.sessionId,
        { forceCatalogRefresh: true, waitForCatalogRefresh: true },
      );
      if (!matchedHistory
        || matchedHistory === "unchanged"
        || matchedHistory.source !== payload.source
        || matchedHistory.session_id !== payload.sessionId
        || normalizeProjectPath(matchedHistory.cwd?.trim() || "") !== normalizeProjectPath(resolvedCwd)) {
        throw operationError("history_context_not_found", "operation context does not match desktop history");
      }
      if (operation.kind === "conversation.history") {
        const paths = getHistoryPathArgsSync();
        await invoke("web_conversation_history", { request: {
          operationId: operation.id, filePath: matchedHistory.file_path,
          projectKey: matchedHistory.project_key, cwd: resolvedCwd,
          rootPath: worktree?.path ?? project.path,
          claudeConfigDir: paths.claudeConfigDir ?? null,
          codexConfigDir: paths.codexConfigDir ?? null,
        } });
        activeOperationIds.delete(operation.id);
        return;
      }
    }
    await webDeviceApi.validateContext(worktree?.path ?? project.path, resolvedCwd);

    const launchProject = worktree ? projectWithWorktreeProviderOverrides(project, worktree) : project;
    const startupCommand = resolveProjectStartupCommand(launchProject);
    if (!startupCommand) throw operationError("cli_not_configured", "project CLI startup command is not configured");

    const launch = parseWebConversationLaunch(startupCommand, payload.source);
    const environment: unknown = launchProject.env_vars?.trim() ? JSON.parse(launchProject.env_vars) : {};
    if (!environment || typeof environment !== "object" || Array.isArray(environment)
      || Object.values(environment).some((value) => typeof value !== "string")) {
      throw operationError("invalid_environment", "Project environment must contain string values.");
    }
    await invoke("web_conversation_start", { request: {
      operationId: operation.id, source: payload.source, projectId: project.id,
      worktreeId: worktree?.id ?? null, cwd: resolvedCwd,
      rootPath: worktree?.path ?? project.path, sessionId: payload.sessionId ?? null,
      ...launch, environment, locale: getCurrentLanguage() === "en-US" ? "en-US" : "zh-CN",
    } });
    activeOperationIds.delete(operation.id);
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

async function publishWorkspace(workspaceOnly = false) {
  try {
    const projectStore = useProjectStore.getState();
    if (!projectStore.loaded) await projectStore.fetchAll("startup");
    const status = await webDeviceApi.getStatus();
    if (!status.paired || !status.connected || !status.profile) return;
    if (!workspaceOnly && !webHistoryLoaded) {
      await useHistoryStore.getState().loadSessions({ background: true });
      webHistoryLoaded = true;
    }
    const { groups, projects, worktrees } = useProjectStore.getState();
    const sessions = workspaceOnly ? [] : useHistoryStore.getState().sessions;
    const publishedSessions: WebHistorySessionSummary[] = sessions.map((session) => {
      const sessionCwd = session.cwd?.trim() || "";
      const worktree = sessionCwd
        ? worktrees.find((item) => normalizeProjectPath(item.path) === normalizeProjectPath(sessionCwd))
        : undefined;
      const project = worktree
        ? projects.find((item) => item.id === worktree.project_id)
        : sessionCwd
          ? projects.find((item) => item.environment_type !== "ssh" && normalizeProjectPath(item.path) === normalizeProjectPath(sessionCwd))
          : undefined;
      return {
        sessionId: session.session_id,
        deviceId: status.profile!.clientId,
        source: session.source,
        // The project id is an opaque local identifier. Do not send the
        // history project key because older providers often store a path in it.
        projectKey: project?.id ?? "unbound",
        projectId: project?.id ?? null,
        worktreeId: worktree?.id ?? null,
        title: session.title,
        cwd: null,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        messageCount: session.message_count,
        branch: session.branch ?? null,
        freshness: "live",
      };
    });
    const terminalState = useTerminalStore.getState();
    const terminals = terminalState.sessions
      .filter((session) => (!session.kind || session.kind === "pty") && session.projectId && session.environmentType !== "ssh" && !session.remoteHandoff)
      .map((session) => ({ sessionId: session.id, projectId: session.projectId!, worktreeId: session.worktreeId ?? null, title: session.title }));
    const workspace: WebWorkspaceSnapshot = {
      terminals,
      subagents: buildWebSubagentSnapshots(terminalState.sessions, terminalState.subagentTranscripts, new Set(terminals.map((terminal) => terminal.sessionId))),
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        parentId: group.parent_id,
        sortOrder: group.sort_order,
      })),
      projects: projects.map((project) => {
        const source = getProviderSwitchAppType(project);
        return {
          id: project.id,
          name: project.name,
          groupId: project.group_id,
          sortOrder: project.sort_order,
          // The P0 protocol executes only the supported Claude/Codex sources.
          // Keep other registered CLI types visible in the tree without
          // claiming that the desktop bridge can execute them yet.
          source: source === "claude" || source === "codex" ? source : null,
          cwd: resolveProjectPath(project, groups),
          environmentType: project.environment_type,
        };
      }),
      worktrees: worktrees.map((worktree) => ({
        id: worktree.id,
        projectId: worktree.project_id,
        name: worktree.name,
        branch: worktree.branch,
        cwd: worktree.path,
        status: worktree.status,
      })),
      updatedAt: Date.now(),
    };
    await webDeviceApi.publishWorkspace(workspace, publishedSessions, workspaceOnly);
  } catch (caught) {
    logWarn("Failed to publish Web device workspace", caught);
  }
}

export function useWebDeviceBridge(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const polling = startWebBridgePolling({
      getStatus: webDeviceApi.getStatus,
      drainTerminalCommands,
      drainOperations,
      onConnected: () => void publishWorkspace(),
      onError: (error) => logWarn("Failed to poll Web device bridge", error),
    });
    const unlisten = listen(OPERATION_EVENT, () => polling.wake());
    const unlistenStatus = listen<WebDeviceStatus>(STATUS_EVENT, () => polling.wake());
    let workspacePublishTimer: number | null = null;
    const unsubscribeProjects = useProjectStore.subscribe((state, previous) => {
      if (state.groups === previous.groups && state.projects === previous.projects && state.worktrees === previous.worktrees) return;
      if (workspacePublishTimer !== null) window.clearTimeout(workspacePublishTimer);
      workspacePublishTimer = window.setTimeout(() => void publishWorkspace(), 300);
    });
    const workspaceTimer = window.setInterval(() => void publishWorkspace(), WORKSPACE_PUBLISH_MS);
    let transcriptPublishTimer: number | null = null;
    const unsubscribeTerminals = useTerminalStore.subscribe((state, previous) => {
      if (state.sessions === previous.sessions && state.subagentTranscripts === previous.subagentTranscripts) return;
      // Do not reset this deadline: continuous transcript chunks must still reach the Web.
      if (transcriptPublishTimer !== null) return;
      transcriptPublishTimer = window.setTimeout(() => {
        transcriptPublishTimer = null;
        void publishWorkspace(true);
      }, state.sessions !== previous.sessions ? 100 : 1000);
    });
    return () => {
      polling.stop();
      window.clearInterval(workspaceTimer);
      if (workspacePublishTimer !== null) window.clearTimeout(workspacePublishTimer);
      unsubscribeProjects();
      unsubscribeTerminals();
      if (transcriptPublishTimer !== null) window.clearTimeout(transcriptPublishTimer);
      for (const bridge of terminalBridges.values()) {
        bridge.output();
        bridge.status();
        bridge.socket.dispose();
      }
      terminalBridges.clear();
      void unlisten.then((dispose) => dispose());
      void unlistenStatus.then((dispose) => dispose());
    };
  }, [ready]);
}
