import type { Project } from "./types";
import {
  getClaudeProviderOverride,
  getCodexProviderOverride,
  getProviderSwitchAppType,
  isExactCodexProject,
  isNativeProviderReference,
} from "./providerSwitching";
import { replaceGrokModelArg, stripKimiResumeCliArgs, stripResumeCliArgs } from "./resumeCliArgs";
import { normalizeShellKey } from "./shell";

const CODEX_PROFILE_ARG = "--profile";
const CLAUDE_SETTINGS_ARG = "--settings";
const CODEX_LIGHT_TUI_THEME_ARG = "-c theme=catppuccin-latte";
const DIRECT_CODEX_COMMAND_PATTERN = /^(\s*codex(?:\.(?:cmd|exe|ps1))?)(?=\s|$)/i;
const DIRECT_GROK_COMMAND_PATTERN = /^(\s*grok(?:\.(?:cmd|exe|ps1))?)(?=\s|$)/i;

export function isDirectCodexStartupCommand(command?: string | null): boolean {
  const trimmed = command?.trim();
  return Boolean(trimmed && DIRECT_CODEX_COMMAND_PATTERN.test(trimmed));
}

function hasProfileArg(command: string): boolean {
  return new RegExp(`(^|\\s)${CODEX_PROFILE_ARG}(\\s|$)`).test(command);
}

function hasClaudeSettingsArg(command: string): boolean {
  return new RegExp(`(^|\\s)${CLAUDE_SETTINGS_ARG}(\\s|$)`).test(command);
}

function quoteCliArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function windowsPathToWsl(path: string): string | null {
  const trimmed = path.trim();
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed);
  if (!match) return null;
  const drive = match[1].toLowerCase();
  const tail = match[2].replace(/\\/g, "/").replace(/^\/+/, "");
  return tail ? `/mnt/${drive}/${tail}` : `/mnt/${drive}`;
}

function settingsPathForShell(settingsPath: string, shell?: string | null): string {
  const normalizedShell = normalizeShellKey(shell);
  if (normalizedShell !== "wsl" && normalizedShell !== "bash") return settingsPath;
  return windowsPathToWsl(settingsPath) ?? settingsPath;
}

function hasCodexThemeConfigArg(command: string): boolean {
  return /(^|\s)(?:-c|--config)(?:\s+|=)["']?(?:tui\.)?theme\s*=/i.test(command);
}

export function isCodexStartupCommand(command?: string | null): boolean {
  return isDirectCodexStartupCommand(command);
}

export function normalizeDirectCodexStartupCommand(command?: string): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function withCodexLightTuiTheme(command?: string): string | undefined {
  const normalized = normalizeDirectCodexStartupCommand(command);
  if (!normalized || hasCodexThemeConfigArg(normalized)) return normalized;

  const match = DIRECT_CODEX_COMMAND_PATTERN.exec(normalized);
  if (!match) return normalized;

  return `${match[1]} ${CODEX_LIGHT_TUI_THEME_ARG}${normalized.slice(match[1].length)}`;
}

export function withCodexConfigOverrides(
  command: string | undefined,
  overrides: string[],
): string | undefined {
  const normalized = normalizeDirectCodexStartupCommand(command);
  if (!normalized || overrides.length === 0) return normalized;
  const match = DIRECT_CODEX_COMMAND_PATTERN.exec(normalized);
  if (!match) return undefined;

  const args = overrides.map((override) => {
    if (!override.trim() || /["\r\n\0$`%!^&|<>]/.test(override)) {
      throw new Error("provider_codex_override_invalid");
    }
    return `-c "${override}"`;
  });
  return `${match[1]} ${args.join(" ")}${normalized.slice(match[1].length)}`;
}

export function withCodexProfile(command: string | undefined, profileName: string): string | undefined {
  const normalized = normalizeDirectCodexStartupCommand(command);
  const profile = profileName.trim();
  if (!normalized || !profile || hasProfileArg(normalized)) return normalized;
  const match = DIRECT_CODEX_COMMAND_PATTERN.exec(normalized);
  if (!match) return undefined;
  return match[1] + " " + CODEX_PROFILE_ARG + " " + profile + normalized.slice(match[1].length);
}

export function withGrokModelOverride(
  command: string | undefined,
  model: string,
): string | undefined {
  const normalized = command?.trim();
  if (!normalized) return undefined;
  if (!DIRECT_GROK_COMMAND_PATTERN.test(normalized)) return undefined;
  return replaceGrokModelArg(normalized, model);
}

function appendProviderOverrideArgs(
  baseCommand: string,
  project: Pick<Project, "cli_tool" | "provider_overrides" | "shell">,
  options: { includeCodexProviderProfile?: boolean; includeProviderOverrides?: boolean } = {}
): string {
  if (options.includeProviderOverrides === false) return baseCommand;
  let command = baseCommand;
  if (options.includeCodexProviderProfile !== false && isExactCodexProject(project)) {
    const override = getCodexProviderOverride(project);
    if (override && isNativeProviderReference(override) && override.profileName && !hasProfileArg(command)) {
      command = `${command} ${CODEX_PROFILE_ARG} ${override.profileName}`;
    }
  }
  if (getProviderSwitchAppType(project) === "claude") {
    const override = getClaudeProviderOverride(project);
    if (override && isNativeProviderReference(override) && override.settingsPath && !hasClaudeSettingsArg(command)) {
      command = `${command} ${CLAUDE_SETTINGS_ARG} ${quoteCliArg(settingsPathForShell(override.settingsPath, project.shell))}`;
    }
  }
  return command;
}

export function withClaudeSettingsPath(
  command: string | undefined,
  settingsPath: string | undefined,
  shell?: string | null,
): string | undefined {
  const normalizedCommand = command?.trim();
  const normalizedPath = settingsPath?.trim();
  if (!normalizedCommand || !normalizedPath || hasClaudeSettingsArg(normalizedCommand)) {
    return normalizedCommand || undefined;
  }
  return `${normalizedCommand} ${CLAUDE_SETTINGS_ARG} ${quoteCliArg(settingsPathForShell(normalizedPath, shell))}`;
}

export function resolveProjectStartupCommand(
  project: Pick<Project, "cli_tool" | "cli_args" | "startup_cmd" | "provider_overrides" | "shell">,
  options: { includeCodexProviderProfile?: boolean; includeProviderOverrides?: boolean } = {}
): string | undefined {
  const startupCmd = project.startup_cmd.trim();
  if (startupCmd) return normalizeDirectCodexStartupCommand(startupCmd);

  const cliTool = project.cli_tool.trim();
  if (!cliTool) return undefined;

  // 先拼用户维护的 CLI 附加参数，再做供应商覆盖追加：
  // hasProfileArg / hasClaudeSettingsArg 对整条 command 检测，用户手写过的参数天然去重。
  const cliArgs = project.cli_args.trim();
  const command = cliArgs ? `${cliTool} ${cliArgs}` : cliTool;
  return options.includeProviderOverrides === false
    ? command
    : appendProviderOverrideArgs(command, project, options);
}

// 历史会话 resume 命令继承项目启动参数：仅当项目走 cli_tool 分支且工具类型与会话来源一致时追加；
// startup_cmd 是自由文本（可能含一次性 prompt），无法安全拆参，保持不继承。
export function appendResumeCliArgs(
  baseCommand: string,
  source: "claude" | "codex" | "grok" | "kimi",
  project: Pick<Project, "cli_tool" | "cli_args" | "startup_cmd" | "provider_overrides" | "shell"> | null | undefined,
  options: { includeProviderOverrides?: boolean } = {},
): string {
  if (!project || project.startup_cmd.trim()) return baseCommand;
  const matchesSource =
    source === "codex"
      ? isExactCodexProject(project)
      : source === "claude"
        ? getProviderSwitchAppType(project) === "claude"
        : source === "kimi"
          ? project.cli_tool.trim().toLowerCase().includes("kimi")
          : project.cli_tool.trim().toLowerCase().includes("grok");
  if (!matchesSource) return baseCommand;

  const cliArgs = source === "kimi"
    ? stripKimiResumeCliArgs(project.cli_args)
    : stripResumeCliArgs(project.cli_args);
  return appendProviderOverrideArgs(
    cliArgs ? `${baseCommand} ${cliArgs}` : baseCommand,
    project,
    options,
  );
}
