import type { HistorySessionDetail, HistoryToolEvent, ProjectEnvironmentType } from "./types";

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
    const match = path?.trim().match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\|$)/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

function evidenceFromEvent(event: HistoryToolEvent): McpRuntimeEvidence | null {
  const category = event.category?.trim() ?? "";
  const server = category.toLowerCase().startsWith("mcp:")
    ? category.slice(category.indexOf(":") + 1).trim()
    : "";
  if (!server) return null;
  const status = event.status?.trim().toLowerCase() ?? "";
  return {
    server,
    success: !/(?:fail|error|cancel|denied)/.test(status),
    timestamp: event.timestamp ?? null,
  };
}

export function buildSessionMcpEvidence(session: HistorySessionDetail | null): McpRuntimeEvidence[] {
  if (!session?.tool_events?.length) return [];
  const latest = new Map<string, McpRuntimeEvidence>();
  for (const event of session.tool_events) {
    const evidence = evidenceFromEvent(event);
    if (evidence) latest.set(evidence.server.toLowerCase(), evidence);
  }
  return Array.from(latest.values());
}

export function normalizeAgentCapabilityError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const known = text.match(/(?:agent_capability|ssh_agent|agent_probe)_[a-z0-9_]+/i)?.[0];
  return known?.toLowerCase() ?? "agent_capability_failed";
}

