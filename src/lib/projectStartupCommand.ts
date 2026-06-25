import type { Project } from "./types";

const CODEX_NO_ALT_SCREEN_ARG = "--no-alt-screen";
const DIRECT_CODEX_COMMAND_PATTERN = /^(\s*codex(?:\.(?:cmd|exe|ps1))?)(?=\s|$)/i;

function isCodexStartupCommand(command: string): boolean {
  return /\bcodex(?:\.(?:cmd|exe|ps1))?\b/i.test(command);
}

function hasNoAltScreenArg(command: string): boolean {
  return new RegExp(`(^|\\s)${CODEX_NO_ALT_SCREEN_ARG}(\\s|$)`).test(command);
}

export function normalizeDirectCodexStartupCommand(command?: string): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  if (hasNoAltScreenArg(trimmed)) return trimmed;

  const match = DIRECT_CODEX_COMMAND_PATTERN.exec(trimmed);
  if (!match) return trimmed;

  return `${match[1]} ${CODEX_NO_ALT_SCREEN_ARG}${trimmed.slice(match[1].length)}`;
}

export function resolveProjectStartupCommand(project: Pick<Project, "cli_tool" | "startup_cmd">): string | undefined {
  const startupCmd = project.startup_cmd.trim();
  if (startupCmd) return normalizeDirectCodexStartupCommand(startupCmd);

  const cliTool = project.cli_tool.trim();
  if (!cliTool) return undefined;
  if (isCodexStartupCommand(cliTool) && !hasNoAltScreenArg(cliTool)) {
    return `${cliTool} ${CODEX_NO_ALT_SCREEN_ARG}`;
  }

  return cliTool;
}
