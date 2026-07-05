import type { Project } from "./types";
import { getClaudeProviderOverride, getCodexProviderOverride, getProviderSwitchAppType, isExactCodexProject } from "./providerSwitching";
import { normalizeShellKey } from "./shell";

const CODEX_PROFILE_ARG = "--profile";
const CLAUDE_SETTINGS_ARG = "--settings";
const CODEX_LIGHT_TUI_THEME_ARG = "-c theme=catppuccin-latte";
const DIRECT_CODEX_COMMAND_PATTERN = /^(\s*codex(?:\.(?:cmd|exe|ps1))?)(?=\s|$)/i;

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

export function resolveProjectStartupCommand(
  project: Pick<Project, "cli_tool" | "cli_args" | "startup_cmd" | "provider_overrides" | "shell">,
  options: { includeCodexProviderProfile?: boolean } = {}
): string | undefined {
  const startupCmd = project.startup_cmd.trim();
  if (startupCmd) return normalizeDirectCodexStartupCommand(startupCmd);

  const cliTool = project.cli_tool.trim();
  if (!cliTool) return undefined;

  // 先拼用户维护的 CLI 附加参数，再做供应商覆盖追加：
  // hasProfileArg / hasClaudeSettingsArg 对整条 command 检测，用户手写过的参数天然去重。
  const cliArgs = project.cli_args.trim();
  let command = cliArgs ? `${cliTool} ${cliArgs}` : cliTool;
  if (options.includeCodexProviderProfile !== false && isExactCodexProject(project)) {
    const override = getCodexProviderOverride(project);
    if (override && !hasProfileArg(command)) {
      command = `${command} ${CODEX_PROFILE_ARG} ${override.profileName}`;
    }
  }
  if (getProviderSwitchAppType(project) === "claude") {
    const override = getClaudeProviderOverride(project);
    if (override && !hasClaudeSettingsArg(command)) {
      command = `${command} ${CLAUDE_SETTINGS_ARG} ${quoteCliArg(settingsPathForShell(override.settingsPath, project.shell))}`;
    }
  }
  return command;
}
