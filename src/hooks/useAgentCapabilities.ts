import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildSessionMcpEvidence,
  inferWslDistroName,
  normalizeAgentCapabilityError,
  resolveAgentRuntimeKind,
  type AgentCapabilityRequest,
  type AgentCapabilitySnapshot,
} from "../lib/agentCapabilities";
import { buildSshAgentProjectLaunch, type SshAgentProjectLaunch } from "../lib/sshAgentHistory";
import type { HistorySessionDetail, Project, ProjectEnvironmentType, TerminalSession } from "../lib/types";

const snapshotCache = new Map<string, AgentCapabilitySnapshot>();
const baselineFingerprints = new Map<string, string>();

function markSnapshotChecking(snapshot: AgentCapabilitySnapshot): AgentCapabilitySnapshot {
  const mcp = snapshot.mcp.map((item) => item.activation === "active"
    ? { ...item, health: "checking" as const, errorCode: null }
    : item);
  return {
    ...snapshot,
    mcp,
    mcpSummary: {
      ...snapshot.mcpSummary,
      healthy: 0,
      error: 0,
      unknown: 0,
      checking: snapshot.mcpSummary.active,
    },
  };
}

interface UseAgentCapabilitiesInput {
  terminalSession: TerminalSession | null;
  project: Project | null;
  boundSession: HistorySessionDetail | null;
  projectPath: string | null;
  active: boolean;
  enabled: boolean;
  refreshSeq: number | string;
}

interface SshLaunchCache {
  projectId: string;
  launch: SshAgentProjectLaunch;
}

export interface OpenCodeHookStatus {
  configDir: string;
  pluginPath: string;
  status: "notInstalled" | "installed" | "conflict";
}

function environmentFor(session: TerminalSession, project: Project | null): ProjectEnvironmentType {
  return session.environmentType ?? project?.environment_type ?? "local";
}

export function useAgentCapabilities({
  terminalSession,
  project,
  boundSession,
  projectPath,
  active,
  enabled,
  refreshSeq,
}: UseAgentCapabilitiesInput) {
  const agent = useMemo(
    () => resolveAgentRuntimeKind(
      `${terminalSession?.cliTool ?? ""} ${terminalSession?.startupCmd ?? ""} ${terminalSession?.title ?? ""} ${project?.cli_tool ?? ""}`
    ),
    [project?.cli_tool, terminalSession?.cliTool, terminalSession?.startupCmd, terminalSession?.title]
  );
  const cliSessionId = terminalSession?.cliSessionId?.trim() ?? "";
  const environment = terminalSession ? environmentFor(terminalSession, project) : "local";
  const wslDistroName = environment === "wsl"
    ? inferWslDistroName(terminalSession?.cwd, projectPath, project?.path, project?.cli_config_root)
    : null;
  const effectiveCwd = environment === "ssh"
    ? (terminalSession?.remotePath?.trim() || project?.remote_path.trim() || "")
    : (projectPath?.trim() || terminalSession?.cwd?.trim() || "");
  const scopeKey = terminalSession && agent && effectiveCwd
    ? JSON.stringify([
        terminalSession.id,
        cliSessionId,
        agent,
        environment,
        terminalSession.sshHostId ?? "",
        wslDistroName ?? "",
        effectiveCwd,
        project?.cli_config_root ?? "",
      ])
    : "";

  const [snapshotState, setSnapshotState] = useState<{ scopeKey: string; value: AgentCapabilitySnapshot } | null>(null);
  const [loadingScope, setLoadingScope] = useState<string | null>(null);
  const [probingScope, setProbingScope] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<{ scopeKey: string; code: string } | null>(null);
  const [openCodeHookStatus, setOpenCodeHookStatus] = useState<OpenCodeHookStatus | null>(null);
  const [openCodeHookLoading, setOpenCodeHookLoading] = useState(false);
  const [openCodeHookError, setOpenCodeHookError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const sshLaunchRef = useRef<SshLaunchCache | null>(null);

  const snapshot = snapshotState?.scopeKey === scopeKey ? snapshotState.value : null;
  const loading = loadingScope === scopeKey;
  const probing = probingScope === scopeKey;
  const errorCode = errorState?.scopeKey === scopeKey ? errorState.code : null;

  const buildRequest = useCallback(async (): Promise<AgentCapabilityRequest | null> => {
    if (!terminalSession || !agent || !cliSessionId || !effectiveCwd || !scopeKey) return null;
    const request: AgentCapabilityRequest = {
      terminalSessionId: terminalSession.id,
      cliSessionId,
      agent,
      environment,
      cwd: effectiveCwd,
      configRoot: project?.cli_config_root?.trim() || null,
      launchArgs: project?.cli_args ?? "",
      baselineConfigFingerprint: baselineFingerprints.get(scopeKey) ?? null,
      runtimeEvidence: buildSessionMcpEvidence(boundSession),
      wslDistroName,
    };
    if (environment === "ssh") {
      if (!project) return null;
      let cached = sshLaunchRef.current;
      if (!cached || cached.projectId !== project.id) {
        cached = { projectId: project.id, launch: await buildSshAgentProjectLaunch(project, "") };
        sshLaunchRef.current = cached;
      }
      request.sshLaunch = cached.launch;
      request.sshConsumerId = `agent-capabilities:${cached.launch.clientInstanceId}:${cached.launch.hostId}:${project.id}:${terminalSession.id}`;
    }
    return request;
  }, [agent, boundSession, cliSessionId, effectiveCwd, environment, project, scopeKey, terminalSession, wslDistroName]);

  const load = useCallback(async (probe: boolean) => {
    const requestScope = scopeKey;
    const generation = ++requestGeneration.current;
    if (!requestScope) return;
    let probeBaseline: AgentCapabilitySnapshot | null = null;
    if (probe) setProbingScope(requestScope);
    else setLoadingScope(requestScope);
    if (probe) {
      setSnapshotState((current) => {
        if (current?.scopeKey !== requestScope) return current;
        probeBaseline = current.value;
        return { scopeKey: requestScope, value: markSnapshotChecking(current.value) };
      });
    }
    setErrorState((current) => current?.scopeKey === requestScope ? null : current);
    try {
      const request = await buildRequest();
      if (!request) return;
      const value = await invoke<AgentCapabilitySnapshot>(
        probe ? "agent_capabilities_probe" : "agent_capabilities_inspect",
        { request }
      );
      if (generation !== requestGeneration.current || requestScope !== scopeKey) return;
      snapshotCache.set(requestScope, value);
      if (!baselineFingerprints.has(requestScope)) {
        baselineFingerprints.set(requestScope, value.configFingerprint);
      }
      setSnapshotState({ scopeKey: requestScope, value });
    } catch (error) {
      if (generation === requestGeneration.current && requestScope === scopeKey) {
        if (probeBaseline) setSnapshotState({ scopeKey: requestScope, value: probeBaseline });
        setErrorState({ scopeKey: requestScope, code: normalizeAgentCapabilityError(error) });
      }
    } finally {
      if (generation === requestGeneration.current) {
        if (probe) setProbingScope(null);
        else setLoadingScope(null);
      }
    }
  }, [buildRequest, scopeKey]);

  useEffect(() => {
    requestGeneration.current += 1;
    if (!scopeKey) {
      setSnapshotState(null);
      setErrorState(null);
      return;
    }
    const cached = snapshotCache.get(scopeKey);
    setSnapshotState(cached ? { scopeKey, value: cached } : null);
    setErrorState(null);
  }, [scopeKey]);

  useEffect(() => {
    if (!active || !enabled || !agent || !cliSessionId || !scopeKey) return;
    void load(false);
  }, [active, agent, cliSessionId, enabled, load, refreshSeq, scopeKey]);

  useEffect(() => {
    if (!active || !enabled || agent !== "opencode" || environment !== "local") {
      setOpenCodeHookStatus(null);
      setOpenCodeHookError(null);
      return;
    }
    let cancelled = false;
    setOpenCodeHookLoading(true);
    setOpenCodeHookError(null);
    void invoke<OpenCodeHookStatus>("opencode_hook_status")
      .then((status) => {
        if (!cancelled) setOpenCodeHookStatus(status);
      })
      .catch((error) => {
        if (!cancelled) setOpenCodeHookError(normalizeAgentCapabilityError(error));
      })
      .finally(() => {
        if (!cancelled) setOpenCodeHookLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, agent, enabled, environment]);

  const installOpenCodeHook = useCallback(async () => {
    if (agent !== "opencode" || environment !== "local") return;
    setOpenCodeHookLoading(true);
    setOpenCodeHookError(null);
    try {
      const status = await invoke<OpenCodeHookStatus>("opencode_hook_install");
      setOpenCodeHookStatus(status);
    } catch (error) {
      setOpenCodeHookError(normalizeAgentCapabilityError(error));
    } finally {
      setOpenCodeHookLoading(false);
    }
  }, [agent, environment]);

  const refresh = useCallback(() => load(false), [load]);
  const probe = useCallback(() => load(true), [load]);

  return {
    agent,
    cliSessionId,
    environment,
    snapshot,
    loading,
    probing,
    errorCode,
    openCodeHookStatus,
    openCodeHookLoading,
    openCodeHookError,
    installOpenCodeHook,
    refresh,
    probe,
  };
}
