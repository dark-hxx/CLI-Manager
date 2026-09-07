import { invoke } from "@tauri-apps/api/core";
import type { Project, NativeProviderLaunchSnapshot, TerminalSession } from "../../../lib/types";
import { createAgentTerminalMetadata, resolveAgentTerminalMetadata } from "../../../lib/agentTerminal";
import { logError, logWarn } from "../../../lib/logger";
import {
  appendResumeCliArgs, isDirectCodexStartupCommand, normalizeDirectCodexStartupCommand,
  resolveProjectStartupCommand, withClaudeSettingsPath, withCodexConfigOverrides, withCodexProfile,
  withCodexLightTuiTheme, withGrokModelOverride,
} from "../../../lib/projectStartupCommand";
import { getTerminalTheme } from "../../../lib/terminalThemes";
import { normalizeHexColor } from "../../../lib/terminalColor";
import { useSettingsStore } from "../../../stores/settingsStore";
import {
  defaultShellForOs, getOsPlatform, normalizeShellForOs, normalizeShellKey, type OsPlatform,
  type ShellKey,
} from "../../../lib/shell";
import { getProviderSwitchAppType, isExactCodexProject, parseProjectEnvVars } from "../../../lib/providerSwitching";
import { useProjectStore } from "../../../stores/projectStore";
import { useSshHostStore } from "../../../stores/sshHostStore";
import { useSshAgentIntegrationStore } from "../../../stores/sshAgentIntegrationStore";
import { buildSshConnectionSpec } from "../../../lib/ssh";
import { parseStoredSshHookReport, resolveSshToolSource } from "../../../lib/sshToolIntegration";
import { getSshClientInstanceId } from "../../../lib/sshClientIdentity";
import { isValidGrokSessionId, isValidKimiSessionId } from "../../../lib/resumeCliArgs";
import {
  terminalProcessManager, type TerminalClaudeProviderLaunchConfig,
  type TerminalCodexProviderLaunchConfig, type TerminalGrokProviderLaunchConfig,
} from "../../../terminal/core/TerminalProcessManager";
import {
  type HookSettingsStatusPayload, type OpenCodeHookStatusPayload, type DetachedPtyLaunchOptions,
  type DetachedPtyLaunchResult, type ProviderLaunchSnapshotResponse, type ResolvedPtyLaunch,
} from "../types/terminalStoreTypes";
import { SHELL_RUNTIME_MONITORING_ENV } from "./terminalStatus";

export function supportsShellRuntimeInjection(shell?: string | null): boolean {
  const normalized = normalizeShellKey(shell);
  return (
    normalized === "powershell" ||
    normalized === "pwsh" ||
    normalized === "cmd" ||
    normalized === "gitbash"
  );
}

export function isShellRuntimeMonitoringEnabled(): boolean {
  return useSettingsStore.getState().shellRuntimeMonitoringEnabled;
}

export function resolveShellForPty(shell: string | null | undefined, hasProject: boolean, os: OsPlatform): string | null {
  const inputShell = normalizeShellForOs(shell, os);
  if (inputShell) return inputShell;
  const customShell = shell?.trim();
  if (customShell && !normalizeShellKey(customShell)) return customShell;
  if (hasProject) return null;
  return normalizeShellForOs(useSettingsStore.getState().defaultShell, os) ?? defaultShellForOs(os);
}

export function isLightHexColor(value: string | undefined): boolean {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return false;
  const r = Number.parseInt(value.slice(1, 3), 16);
  const g = Number.parseInt(value.slice(3, 5), 16);
  const b = Number.parseInt(value.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}

export function isCurrentTerminalBackgroundLight(): boolean {
  const settings = useSettingsStore.getState();
  const theme = getTerminalTheme(settings.terminalThemeName, settings.resolvedTheme, settings.lightThemePalette, settings.darkThemePalette);
  return isLightHexColor(theme.background);
}

export function getCurrentTerminalColors() {
  const settings = useSettingsStore.getState();
  const theme = getTerminalTheme(
    settings.terminalThemeName,
    settings.resolvedTheme,
    settings.lightThemePalette,
    settings.darkThemePalette,
  );
  return {
    foreground: normalizeHexColor(settings.terminalTextColor || theme.foreground, "#d8dee9"),
    background: normalizeHexColor(
      theme.background,
      settings.resolvedTheme === "dark" ? "#0c0e10" : "#ffffff",
    ),
  };
}

export function prepareStartupCommandForPty(command: string | undefined, shell: ShellKey | null): string | undefined {
  if (!command || shell !== "gitbash" || !isCurrentTerminalBackgroundLight()) return command;
  return withCodexLightTuiTheme(command);
}

export const CODEX_COMMAND_PATTERN = /(?:^|\s)codex(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;

export const CLAUDE_COMMAND_PATTERN = /(?:^|\s)claude(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;

export const GROK_COMMAND_PATTERN = /(?:^|\s)grok(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;

export const KIMI_COMMAND_PATTERN = /(?:^|\s)kimi(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;

export function detectCliResumeKind(
  startupCmd: string | undefined,
  project: Project | undefined
): "claude" | "codex" | "grok" | "kimi" | null {
  const cmd = startupCmd?.trim() ?? "";
  const projectKind = project ? getProviderSwitchAppType(project) : null;
  const cliTool = project?.cli_tool?.trim().toLowerCase() ?? "";
  // codex 优先：codex 项目可能带自定义 startupCmd，仍应当 codex resume。
  if (projectKind === "codex" || (project ? isExactCodexProject(project) : false) || CODEX_COMMAND_PATTERN.test(cmd)) {
    return "codex";
  }
  if (projectKind === "claude" || CLAUDE_COMMAND_PATTERN.test(cmd)) {
    return "claude";
  }
  if (cliTool.includes("grok") || GROK_COMMAND_PATTERN.test(cmd)) {
    return "grok";
  }
  if (cliTool.includes("kimi") || KIMI_COMMAND_PATTERN.test(cmd)) {
    return "kimi";
  }
  return null;
}

export function buildCliResumeStartupCommand(
  kind: "claude" | "codex" | "grok" | "kimi",
  cliSessionId: string | undefined,
  project: Project | undefined,
  options: { includeProviderOverrides?: boolean } = {},
): string {
  const id = cliSessionId?.trim();
  const hasValidId = !!id && !/\s/.test(id) && !/[\r\n]/.test(id);
  if (kind === "codex") {
    const base = hasValidId ? `codex resume --no-alt-screen ${id}` : "codex resume --no-alt-screen --last";
    return appendResumeCliArgs(base, "codex", project ?? null, options);
  }
  if (kind === "grok") {
    // Align with Claude: no --no-alt-screen by default. No id → cwd-scoped continue.
    const base = hasValidId && isValidGrokSessionId(id) ? `grok --resume ${id}` : "grok --continue";
    return appendResumeCliArgs(base, "grok", project ?? null, options);
  }
  if (kind === "kimi") {
    const base = hasValidId && isValidKimiSessionId(id)
      ? `kimi --session ${id}`
      : "kimi --continue";
    return appendResumeCliArgs(base, "kimi", project ?? null, options);
  }
  const base = hasValidId ? `claude --resume ${id}` : "claude --continue";
  return appendResumeCliArgs(base, "claude", project ?? null, options);
}

export function buildDirectCodexLaunchCommand(command: string): string {
  const normalized = normalizeDirectCodexStartupCommand(command) ?? command.trim();
  return `\x0c${normalized}`;
}

export function formatStartupInputForPty(command: string, _shell?: ShellKey | null): string {
  if (!isDirectCodexStartupCommand(command)) return `${command}\r`;
  return `${buildDirectCodexLaunchCommand(command)}\r`;
}

export function formatManualDirectCodexInputForPty(command: string, shell?: ShellKey | null): string {
  return formatStartupInputForPty(command, shell ?? null);
}

export const HOOK_RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

export async function shouldEnableHookEnv(): Promise<boolean> {
  const settings = useSettingsStore.getState();
  let openCodeInstalled = false;
  try {
    const openCodeStatus = await invoke<OpenCodeHookStatusPayload>("opencode_hook_status");
    openCodeInstalled = openCodeStatus.status === "installed";
  } catch (err) {
    logError("opencode_hook_status failed while deciding terminal hook env", { err });
  }
  if (
    !settings.claudeHookBridgeEnabled &&
    !settings.codexHookBridgeEnabled &&
    !settings.kimiHookBridgeEnabled &&
    !settings.piHookBridgeEnabled &&
    !settings.grokHookBridgeEnabled
  ) {
    return openCodeInstalled;
  }
  try {
    const status = await invoke<HookSettingsStatusPayload>("hook_settings_get_status", {
      selectedDir: settings.claudeHookConfigDir?.trim() || null,
      codexSelectedDir: settings.codexHookConfigDir?.trim() || null,
      kimiSelectedDir: settings.kimiHookConfigDir?.trim() || null,
      piSelectedDir: settings.piHookConfigDir?.trim() || null,
      grokSelectedDir: settings.grokHookConfigDir?.trim() || null,
      ccSwitchDbPath: settings.ccSwitchDbPath ?? undefined,
      autoRepair: settings.claudeHookBridgeEnabled && settings.claudeHookAutoRepairKnownInstalled,
    });
    return openCodeInstalled || (
      (settings.claudeHookBridgeEnabled && status.claude.status === "installed") ||
      (settings.codexHookBridgeEnabled && status.codex.status === "installed") ||
      (settings.kimiHookBridgeEnabled && status.kimi.status === "installed") ||
      (settings.piHookBridgeEnabled && status.pi.status === "installed") ||
      (settings.grokHookBridgeEnabled && status.grok.status === "installed")
    );
  } catch (err) {
    logError("hook_settings_get_status failed while deciding terminal hook env", { err });
    return openCodeInstalled;
  }
}

export function buildPtyEnvVars(
  envVars?: Record<string, string> | null,
  shell?: string | null
): Record<string, string> | null {
  const next = { ...(envVars ?? {}) };
  if (isShellRuntimeMonitoringEnabled() && supportsShellRuntimeInjection(shell)) {
    next[SHELL_RUNTIME_MONITORING_ENV] = "1";
  } else {
    delete next[SHELL_RUNTIME_MONITORING_ENV];
  }
  return Object.keys(next).length > 0 ? next : null;
}

export function getProjectAgentTerminalMetadata(projectId?: string) {
  const project = projectId
    ? useProjectStore.getState().projects.find((item) => item.id === projectId)
    : undefined;
  return createAgentTerminalMetadata(project);
}

export function getRestoredAgentTerminalMetadata(
  session: Pick<TerminalSession, "isAgentSession" | "cliTool"> | null | undefined,
  projectId?: string
) {
  const project = projectId
    ? useProjectStore.getState().projects.find((item) => item.id === projectId)
    : undefined;
  return resolveAgentTerminalMetadata(session, project);
}

export async function prepareProviderLaunchSnapshot(
  project: Project | null,
  startupCmd: string | null | undefined,
  worktreeId?: string,
  persistedSnapshot?: NativeProviderLaunchSnapshot | null,
  providerId?: string | null,
): Promise<ProviderLaunchSnapshotResponse | null> {
  if (persistedSnapshot) releaseProviderSnapshot(persistedSnapshot);
  const appType = project ? getProviderSwitchAppType(project) : null;
  if (!project || !appType) return null;
  if (!startupCmd?.trim()) return null;
  // 跟随全局时后端返回 null：全局 apply 已写入真实 Home，启动无需任何供应商参数。
  return invoke<ProviderLaunchSnapshotResponse | null>("provider_scope_prepare", {
    input: {
      appType,
      projectId: project.id,
      worktreeId: worktreeId ?? null,
      providerId: providerId?.trim() || null,
    },
  });
}

export function buildNativeProviderLaunchConfigs(
  snapshot: ProviderLaunchSnapshotResponse | null,
): {
  claudeProvider: TerminalClaudeProviderLaunchConfig | null;
  codexProvider: TerminalCodexProviderLaunchConfig | null;
  grokProvider: TerminalGrokProviderLaunchConfig | null;
} {
  if (!snapshot) {
    return { claudeProvider: null, codexProvider: null, grokProvider: null };
  }
  if (snapshot.appType === "claude") {
    if (!snapshot.claudeSettingsPath) throw new Error("provider_snapshot_missing");
    return {
      claudeProvider: {
        appType: "claude",
        providerId: snapshot.providerId,
        snapshotId: snapshot.snapshotId,
        claudeSettingsPath: snapshot.claudeSettingsPath,
      },
      codexProvider: null,
      grokProvider: null,
    };
  }
  if (snapshot.appType === "codex") {
    if (snapshot.generatedHome || (!snapshot.codexProfileName && snapshot.configOverrides.length === 0)) {
      throw new Error("provider_snapshot_missing");
    }
    return {
      claudeProvider: null,
      codexProvider: {
        appType: "codex",
        providerId: snapshot.providerId,
        snapshotId: snapshot.snapshotId,
      },
      grokProvider: null,
    };
  }
  if (snapshot.generatedHome || !snapshot.grokModel?.trim()) {
    throw new Error("provider_snapshot_missing");
  }
  return {
    claudeProvider: null,
    codexProvider: null,
    grokProvider: {
      appType: "grokbuild",
      providerId: snapshot.providerId,
      snapshotId: snapshot.snapshotId,
      grokModel: snapshot.grokModel,
    },
  };
}

export async function garbageCollectProviderSnapshots(sessions: TerminalSession[]): Promise<void> {
  try {
    await invoke("provider_scope_gc_snapshots", {
      activeSnapshotIds: sessions
        .map((session) => session.providerSnapshot?.snapshotId)
        .filter((snapshotId): snapshotId is string => Boolean(snapshotId?.trim())),
    });
  } catch (err) {
    logWarn("provider snapshot garbage collection failed", { err });
  }
}

export function releaseProviderSnapshot(snapshot: NativeProviderLaunchSnapshot | null | undefined): void {
  const snapshotId = snapshot?.snapshotId?.trim();
  if (!snapshotId) return;
  void invoke("provider_scope_release_snapshot", { snapshotId }).catch((err) => {
    logWarn("provider snapshot release failed", { snapshotId, err });
  });
}

export async function resolvePtyLaunch(options: DetachedPtyLaunchOptions, os: OsPlatform): Promise<ResolvedPtyLaunch> {
  const project = options.projectId
    ? useProjectStore.getState().projects.find((item) => item.id === options.projectId)
    : undefined;

  const requestedSshHostId = project?.environment_type === "ssh"
    ? project.ssh_host_id?.trim()
    : options.sshHostId?.trim();
  if (project?.environment_type === "ssh" && !requestedSshHostId) {
    throw new Error("ssh_project_configuration_invalid");
  }
  if (requestedSshHostId) {
    const sshHostId = requestedSshHostId;
    const remotePath = project?.environment_type === "ssh"
      ? project.remote_path.trim()
      : options.cwd?.trim() || "/";
    if (!sshHostId || !remotePath) throw new Error("ssh_project_configuration_invalid");

    const sshStore = useSshHostStore.getState();
    if (!sshStore.loaded) await sshStore.fetchHosts();
    const hosts = useSshHostStore.getState().hosts;
    const host = hosts.find((candidate) => candidate.id === sshHostId);
    if (!host) throw new Error("ssh_host_not_found");
    const resolvedStartupCmd = options.startupCmd === undefined && project?.environment_type === "ssh"
      ? resolveProjectStartupCommand(project, { includeProviderOverrides: false })
      : options.startupCmd?.trim() || undefined;
    const resolvedEnvironmentOverrides = options.envVars === undefined && project?.environment_type === "ssh"
      ? parseProjectEnvVars(project) ?? {}
      : options.envVars ?? {};
    const toolSource = project?.environment_type === "ssh"
      ? resolveSshToolSource(project.cli_tool)
      : null;
    let agentInstallation: ReturnType<typeof useSshAgentIntegrationStore.getState>["installations"][number] | undefined;
    let hookBridgeEnabled = false;
    if (toolSource) {
      const integrationStore = useSshAgentIntegrationStore.getState();
      if (!integrationStore.loaded) await integrationStore.fetchAll();
      const integrationState = useSshAgentIntegrationStore.getState();
      agentInstallation = integrationState.installations.find(
        (candidate) => candidate.host_id === host.id && candidate.status === "installed",
      );
      const hostConfiguredRoot = integrationState.preferences.find(
        (preference) => preference.host_id === host.id && preference.source === toolSource,
      )?.configured_root.trim();
      const effectiveConfigRoot = project?.cli_config_root.trim() || hostConfiguredRoot || "";
      if (effectiveConfigRoot) {
        const environmentKey = {
          claude: "CLAUDE_CONFIG_DIR",
          codex: "CODEX_HOME",
          kimi: "KIMI_CODE_HOME",
          grok: "GROK_HOME",
        }[toolSource];
        resolvedEnvironmentOverrides[environmentKey] = effectiveConfigRoot;
      }
      const hookIntegration = integrationState.integrations.find((candidate) => (
        candidate.host_id === host.id
        && candidate.source === toolSource
        && candidate.configured_root === effectiveConfigRoot
        && candidate.cleanup_state === "active"
      ));
      const hookReport = hookIntegration
        ? parseStoredSshHookReport(hookIntegration.hook_record_json)
        : null;
      hookBridgeEnabled = Boolean(
        agentInstallation
        && hookReport?.status === "installed"
        && hookReport.installationId === agentInstallation.installation_id
        && hookReport.remoteMachineId === agentInstallation.remote_machine_id,
      );
    }

    return {
      shell: null,
      startupCmd: resolvedStartupCmd,
      startupHandledByLaunch: true,
      environmentType: "ssh",
      sshHostId: host.id,
      remotePath,
      providerSnapshot: null,
      invokeArgs: {
        cwd: null,
        envVars: null,
        shell: null,
        hookEnvEnabled: false,
        claudeProvider: null,
        codexProvider: null,
        grokProvider: null,
        terminalColors: getCurrentTerminalColors(),
        sshLaunch: {
          ...buildSshConnectionSpec(host, hosts),
          hostId: host.id,
          remotePath,
          clientInstanceId: getSshClientInstanceId(),
          projectId: project?.id ?? "",
          projectName: project?.name.trim() ?? "",
          bridgeEpoch: crypto.randomUUID(),
          agentPath: hookBridgeEnabled ? agentInstallation?.install_path ?? "" : "",
          agentInstallationId: hookBridgeEnabled ? agentInstallation?.installation_id ?? "" : "",
          agentRemoteMachineId: hookBridgeEnabled ? agentInstallation?.remote_machine_id ?? "" : "",
          toolSource: hookBridgeEnabled ? toolSource ?? "" : "",
          environmentOverrides: resolvedEnvironmentOverrides,
          initializationCommand: host.startup_script.trim() || null,
          startupCommand: resolvedStartupCmd ?? null,
        },
      },
    };
  }

  const resolvedShell = resolveShellForPty(options.shell, !!options.projectId, os);
  const resolvedStartupCmd = options.startupCmd == null && project
    ? resolveProjectStartupCommand(project)
    : options.startupCmd?.trim() || undefined;
  const providerSnapshot = await prepareProviderLaunchSnapshot(
    project ?? null,
    resolvedStartupCmd,
    options.worktreeId,
    options.providerSnapshot,
    options.providerId,
  );
  const providerConfigs = buildNativeProviderLaunchConfigs(
    providerSnapshot,
  );
  let providerStartupCmd = resolvedStartupCmd;
  if (providerSnapshot?.appType === "codex") {
    providerStartupCmd = providerSnapshot.codexProfileName
      ? withCodexProfile(resolvedStartupCmd, providerSnapshot.codexProfileName)
      : withCodexConfigOverrides(resolvedStartupCmd, providerSnapshot.configOverrides);
    if (!providerStartupCmd) {
      releaseProviderSnapshot(providerSnapshot);
      throw new Error("provider_codex_command_unsupported");
    }
  } else if (providerSnapshot?.appType === "grokbuild") {
    providerStartupCmd = withGrokModelOverride(
      resolvedStartupCmd,
      providerSnapshot.grokModel ?? "",
    );
    if (!providerStartupCmd) {
      releaseProviderSnapshot(providerSnapshot);
      throw new Error("provider_grok_command_unsupported");
    }
  }
  let startupCmd = prepareStartupCommandForPty(
    providerStartupCmd,
    normalizeShellKey(resolvedShell) ?? null,
  );
  if (providerSnapshot?.appType === "claude" && CLAUDE_COMMAND_PATTERN.test(startupCmd ?? "")) {
    startupCmd = withClaudeSettingsPath(
      startupCmd,
      providerSnapshot.claudeSettingsPath ?? undefined,
      normalizeShellKey(resolvedShell) ?? null,
    );
  }
  return {
    shell: resolvedShell,
    startupCmd,
    startupHandledByLaunch: false,
    providerSnapshot,
    invokeArgs: {
      cwd: options.cwd ?? null,
      envVars: buildPtyEnvVars(options.envVars ?? null, resolvedShell),
      shell: resolvedShell,
      hookEnvEnabled: await shouldEnableHookEnv(),
      claudeProvider: providerConfigs.claudeProvider,
      codexProvider: providerConfigs.codexProvider,
      grokProvider: providerConfigs.grokProvider,
      terminalColors: getCurrentTerminalColors(),
      sshLaunch: null,
    },
  };
}

export async function createDetachedPtyProcess(options: DetachedPtyLaunchOptions): Promise<DetachedPtyLaunchResult> {
  const os = await getOsPlatform();
  const launch = await resolvePtyLaunch(options, os);
  const sessionId = await terminalProcessManager.create(launch.invokeArgs);

  return {
    sessionId,
    shell: launch.shell,
    startupCmd: launch.startupCmd,
    providerSnapshot: launch.providerSnapshot ?? undefined,
  };
}
