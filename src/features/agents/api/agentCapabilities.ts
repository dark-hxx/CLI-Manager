import { parseWslPath, windowsPathToLinux } from "../../../shared/lib/wslPaths";
import type { HistorySessionDetail, HistoryToolEvent, ProjectEnvironmentType } from "../../../shared/types/index";

export type AgentRuntimeKind = "claude" | "codex" | "pi" | "grok" | "opencode";
export type McpActivation = "active" | "disabled";
export type McpHealth = "healthy" | "error" | "checking" | "unknown";
export type SkillState = "available" | "disabled" | "denied" | "shadowed" | "invalid";
export type AgentBridgeStatus = "ready" | "missing" | "unsupported" | "upgradeRequired";

export interface McpRuntimeEvidence {
  server: string;
  success: boolean;
  timestamp?: string | null;
}

export interface AgentCapabilityRequest {
  terminalSessionId: string;
  cliSessionId: string;
  agent: AgentRuntimeKind;
  environment: ProjectEnvironmentType;
  cwd: string;
  configRoot?: string | null;
  launchArgs: string;
  baselineConfigFingerprint?: string | null;
  runtimeEvidence: McpRuntimeEvidence[];
  wslDistroName?: string | null;
  sshConsumerId?: string | null;
  sshLaunch?: unknown;
}

export interface McpCapabilityItem {
  name: string;
  activation: McpActivation;
  health: McpHealth;
  sourceScope: string;
  sourceKind: string;
  transport: string;
  lastEvidence?: string | null;
  errorCode?: string | null;
}

export interface McpCapabilitySummary {
  active: number;
  disabled: number;
  healthy: number;
  error: number;
  checking: number;
  unknown: number;
}

export interface SkillCapabilityItem {
  name: string;
  description?: string | null;
  state: SkillState;
  scope: string;
  sourceKind: string;
  pathLabel: string;
  errorCode?: string | null;
}

export interface SkillCapabilitySummary {
  total: number;
  available: number;
  disabled: number;
  denied: number;
  shadowed: number;
  invalid: number;
}

export interface AgentCapabilityDiagnostic {
  code: string;
  level: "info" | "warning" | "error";
}

export interface AgentCapabilitySnapshot {
  terminalSessionId: string;
  cliSessionId: string;
  agent: AgentRuntimeKind;
  environment: ProjectEnvironmentType;
  capturedAt: number;
  configFingerprint: string;
  configChanged: boolean;
  bridgeStatus: AgentBridgeStatus;
  mcp: McpCapabilityItem[];
  mcpSummary: McpCapabilitySummary;
  skills: SkillCapabilityItem[];
  skillSummary: SkillCapabilitySummary;
  diagnostics: AgentCapabilityDiagnostic[];
}

export function resolveAgentRuntimeKind(value: string | null | undefined): AgentRuntimeKind | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  if (/\bopencode\b/.test(normalized)) return "opencode";
  if (/\bcodex\b/.test(normalized)) return "codex";
  if (/\bclaude\b/.test(normalized)) return "claude";
  if (/\bgrok(?:\s+build)?\b/.test(normalized)) return "grok";
  if (/(?:^|[\s"'&;|()])pi(?:\.(?:cmd|exe|ps1))?(?:$|[\s"'&;|()])/.test(normalized)) return "pi";
  return null;
}

export function inferWslDistroName(...paths: Array<string | null | undefined>): string | null {
  for (const path of paths) {
    const parsed = parseWslPath(path);
    if (parsed) return parsed.distro;
  }
  return null;
}

// 把 Windows 侧看到的路径归一成 guest 内的 Linux 绝对路径；解析不出返回 null。
export function toWslGuestPath(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const unc = parseWslPath(raw);
  if (unc) return unc.linuxPath;
  const mounted = windowsPathToLinux(raw);
  if (mounted) return mounted;
  if (!raw.startsWith("/")) return null;
  // OSC 7 在 Windows 上会把主机名拼进路径（//<hostname>/home/...）；WSL 会话不可能以 SMB UNC
  // 作为 cwd（创建时已由 pty/wsl_launch.rs 拒绝），所以这里只保留 guest 内的绝对路径。
  if (!raw.startsWith("//")) return raw;
  return raw.slice(2).replace(/^[^/]*/, "") || "/";
}

export interface WslCapabilityLocation {
  distroName: string | null;
  cwd: string | null;
}

// 组装 WSL 能力诊断目标：发行版以 hook 上报的 WSL_DISTRO_NAME 为准，UNC 路径推断兜底；
// boundSessionFilePath 必须先校验 Agent 与 CLI session ID，仅补身份，不把历史文件目录当作 cwd。
export function resolveWslCapabilityLocation(input: {
  hookDistroName?: string | null;
  sessionCwd?: string | null;
  projectPath?: string | null;
  configRoot?: string | null;
  boundSessionFilePath?: string | null;
}): WslCapabilityLocation {
  const hookDistroName = input.hookDistroName?.trim();
  const distroName = hookDistroName || inferWslDistroName(
    input.sessionCwd, input.projectPath, input.configRoot, input.boundSessionFilePath,
  );
  const cwd = toWslGuestPath(input.projectPath) ?? toWslGuestPath(input.sessionCwd);
  return { distroName: distroName || null, cwd };
}

function evidenceFromEvent(event: HistoryToolEvent): McpRuntimeEvidence | null {
  const category = event.category?.trim() ?? "";
  const server = category.toLowerCase().startsWith("mcp:")
    ? category.slice(category.indexOf(":") + 1).trim()
    : "";
  if (!server || event.evidence?.kind === "inferred") return null;
  const status = event.status?.trim().toLowerCase() ?? "";
  if (!["completed", "success", "succeeded", "failed", "error", "errored"].includes(status)) return null;
  return {
    server,
    success: ["completed", "success", "succeeded"].includes(status),
    timestamp: event.timestamp ?? null,
  };
}

export function buildSessionMcpEvidence(session: HistorySessionDetail | null): McpRuntimeEvidence[] {
  if (!session?.tool_events?.length) return [];
  const latest = new Map<string, McpRuntimeEvidence>();
  for (const event of session.tool_events) {
    const evidence = evidenceFromEvent(event);
    if (!evidence) continue;
    const key = evidence.server.toLowerCase();
    const previous = latest.get(key);
    const time = Date.parse(evidence.timestamp ?? "");
    const previousTime = Date.parse(previous?.timestamp ?? "");
    if (!previous || !Number.isFinite(time) || !Number.isFinite(previousTime) || time >= previousTime) {
      latest.set(key, evidence);
    }
  }
  return Array.from(latest.values());
}

export function normalizeAgentCapabilityError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const known = text.match(/(?:agent_capability|ssh_agent|agent_probe)_[a-z0-9_]+/i)?.[0];
  return known?.toLowerCase() ?? "agent_capability_failed";
}

