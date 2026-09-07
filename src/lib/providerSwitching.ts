import type { Project, TerminalSession } from "./types";

export type ProviderSwitchAppType = "claude" | "codex" | "grokbuild";

export interface NativeProviderReference {
  schemaVersion?: number;
  source?: string;
  appType?: ProviderSwitchAppType;
  providerId: string;
  providerName: string | null;
  vendorHint?: string | null;
}

export interface CodexProviderOverride extends NativeProviderReference {
  profileName?: string;
}

export interface ClaudeProviderOverride extends NativeProviderReference {
  settingsPath?: string;
}

export interface GrokProviderOverride extends NativeProviderReference {}

export interface ProjectProviderOverrides {
  claude?: ClaudeProviderOverride;
  codex?: CodexProviderOverride;
  grokbuild?: GrokProviderOverride;
}

const UNCONFIGURED_CLI_TOOL_VALUES = new Set(["none", "未选择", "未選擇"]);

export function hasConfiguredCliTool(project: Pick<Project, "cli_tool">): boolean {
  const cliTool = project.cli_tool.trim().toLowerCase();
  return cliTool.length > 0 && !UNCONFIGURED_CLI_TOOL_VALUES.has(cliTool);
}

export function getProviderSwitchAppType(project: Pick<Project, "cli_tool">): ProviderSwitchAppType | null {
  const cliTool = project.cli_tool.trim().toLowerCase();
  if (cliTool === "codex") return "codex";
  if (cliTool.includes("claude")) return "claude";
  if (cliTool.includes("grok")) return "grokbuild";
  return null;
}

export function getProviderSwitchAppTypeFromCliTool(cliTool: string | null | undefined): ProviderSwitchAppType | null {
  return getProviderSwitchAppType({ cli_tool: cliTool ?? "" });
}

export function resolveProviderSwitchAppType(
  session?: Pick<TerminalSession, "cliTool" | "startupCmd" | "title"> | null,
  project?: Pick<Project, "cli_tool" | "startup_cmd"> | null,
): ProviderSwitchAppType | null {
  const candidates = [
    session?.cliTool,
    session?.startupCmd,
    session?.title,
    project?.cli_tool,
    project?.startup_cmd,
  ];
  for (const candidate of candidates) {
    const appType = getProviderSwitchAppTypeFromCliTool(candidate);
    if (appType) return appType;
  }
  return null;
}

export function isExactCodexProject(project: Pick<Project, "cli_tool">): boolean {
  return project.cli_tool.trim().toLowerCase() === "codex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCodexOverride(value: unknown): CodexProviderOverride | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = typeof value.providerId === "string" ? value.providerId.trim() : "";
  const profileName = typeof value.profileName === "string" ? value.profileName.trim() : "";
  if (!providerId) return undefined;
  return {
    providerId,
    ...(profileName ? { profileName } : {}),
    providerName: typeof value.providerName === "string" && value.providerName.trim() ? value.providerName : null,
    vendorHint: typeof value.vendorHint === "string" && value.vendorHint.trim() ? value.vendorHint.trim() : null,
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    appType: value.appType === "codex" ? "codex" : undefined,
  };
}

function normalizeClaudeOverride(value: unknown): ClaudeProviderOverride | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = typeof value.providerId === "string" ? value.providerId.trim() : "";
  const settingsPath = typeof value.settingsPath === "string" ? value.settingsPath.trim() : "";
  if (!providerId) return undefined;
  return {
    providerId,
    ...(settingsPath ? { settingsPath } : {}),
    providerName: typeof value.providerName === "string" && value.providerName.trim() ? value.providerName : null,
    vendorHint: typeof value.vendorHint === "string" && value.vendorHint.trim() ? value.vendorHint.trim() : null,
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    appType: value.appType === "claude" ? "claude" : undefined,
  };
}

function normalizeGrokOverride(value: unknown): GrokProviderOverride | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = typeof value.providerId === "string" ? value.providerId.trim() : "";
  if (!providerId) return undefined;
  return {
    providerId,
    providerName: typeof value.providerName === "string" && value.providerName.trim() ? value.providerName : null,
    vendorHint: typeof value.vendorHint === "string" && value.vendorHint.trim() ? value.vendorHint.trim() : null,
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    appType: value.appType === "grokbuild" ? "grokbuild" : undefined,
  };
}

export function parseProjectProviderOverrides(raw: string | null | undefined): ProjectProviderOverrides {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const claude = normalizeClaudeOverride(parsed.claude);
    const codex = normalizeCodexOverride(parsed.codex);
    const grokbuild = normalizeGrokOverride(parsed.grokbuild ?? parsed.grok);
    return {
      ...(claude ? { claude } : {}),
      ...(codex ? { codex } : {}),
      ...(grokbuild ? { grokbuild } : {}),
    };
  } catch {
    return {};
  }
}

export function stringifyProjectProviderOverrides(overrides: ProjectProviderOverrides): string {
  const next: Record<string, unknown> = {};
  if (overrides.claude) {
    next.claude = {
      schemaVersion: 2,
      source: "cli-manager",
      appType: "claude",
      providerId: overrides.claude.providerId,
      providerName: overrides.claude.providerName,
    };
    if (overrides.claude.vendorHint) {
      (next.claude as Record<string, unknown>).vendorHint = overrides.claude.vendorHint;
    }
  }
  if (overrides.codex) {
    next.codex = {
      schemaVersion: 2,
      source: "cli-manager",
      appType: "codex",
      providerId: overrides.codex.providerId,
      providerName: overrides.codex.providerName,
    };
    if (overrides.codex.vendorHint) {
      (next.codex as Record<string, unknown>).vendorHint = overrides.codex.vendorHint;
    }
  }
  if (overrides.grokbuild) {
    next.grokbuild = {
      schemaVersion: 2,
      source: "cli-manager",
      appType: "grokbuild",
      providerId: overrides.grokbuild.providerId,
      providerName: overrides.grokbuild.providerName,
    };
    if (overrides.grokbuild.vendorHint) {
      (next.grokbuild as Record<string, unknown>).vendorHint = overrides.grokbuild.vendorHint;
    }
  }
  return JSON.stringify(next);
}

export function getCodexProviderOverride(project: Pick<Project, "provider_overrides">): CodexProviderOverride | undefined {
  return parseProjectProviderOverrides(project.provider_overrides).codex;
}

export function getClaudeProviderOverride(project: Pick<Project, "provider_overrides">): ClaudeProviderOverride | undefined {
  return parseProjectProviderOverrides(project.provider_overrides).claude;
}

export function getGrokProviderOverride(project: Pick<Project, "provider_overrides">): GrokProviderOverride | undefined {
  return parseProjectProviderOverrides(project.provider_overrides).grokbuild;
}

export function isNativeProviderReference(value: NativeProviderReference | undefined): boolean {
  return value?.schemaVersion === 2 && value.source === "cli-manager" && Boolean(value.appType);
}

export function withClaudeProviderOverride(
  raw: string | null | undefined,
  override: ClaudeProviderOverride | null
): string {
  const overrides = parseProjectProviderOverrides(raw);
  if (override) {
    overrides.claude = override;
  } else {
    delete overrides.claude;
  }
  return stringifyProjectProviderOverrides(overrides);
}

export function withCodexProviderOverride(
  raw: string | null | undefined,
  override: CodexProviderOverride | null
): string {
  const overrides = parseProjectProviderOverrides(raw);
  if (override) {
    overrides.codex = override;
  } else {
    delete overrides.codex;
  }
  return stringifyProjectProviderOverrides(overrides);
}

export function withGrokProviderOverride(
  raw: string | null | undefined,
  override: GrokProviderOverride | null
): string {
  const overrides = parseProjectProviderOverrides(raw);
  if (override) {
    overrides.grokbuild = override;
  } else {
    delete overrides.grokbuild;
  }
  return stringifyProjectProviderOverrides(overrides);
}

export function parseProjectEnvVars(project: Pick<Project, "env_vars">): Record<string, string> | undefined {
  try {
    const parsed: unknown = JSON.parse(project.env_vars || "{}");
    if (!isRecord(parsed)) return undefined;
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    if (entries.length > 0) return Object.fromEntries(entries);
  } catch {
    // Ignore invalid env JSON and let terminal start without project env overrides.
  }
  return undefined;
}
