import type { SshRemoteHookConfigReport, SshToolSource } from "./types";

export const DEFAULT_SSH_TOOL_CONFIG_ROOT: Record<SshToolSource, string> = {
  claude: "$HOME/.claude",
  codex: "$HOME/.codex",
};

export function resolveSshToolSource(command: string | null | undefined): SshToolSource | null {
  const executable = command?.trim().split(/\s+/, 1)[0]?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (executable === "claude" || executable === "claude.exe") return "claude";
  if (executable === "codex" || executable === "codex.exe") return "codex";
  return null;
}

export function validateSshToolConfigRoot(value: string): string | null {
  const path = value.trim();
  if (!path) return null;
  if (/[\0\r\n]/.test(path) || path.includes("\\")) return "ssh_tool_config_root_invalid";
  if (path.includes("$") || path.includes("`") || path.includes("$(")) return "ssh_tool_config_root_expansion_forbidden";
  if (!(path.startsWith("/") || path === "~" || path.startsWith("~/"))) return "ssh_tool_config_root_invalid";
  if (path.split("/").some((segment) => segment === "..")) return "ssh_tool_config_root_parent_forbidden";
  return null;
}

export function parseStoredSshHookReport(value: string): SshRemoteHookConfigReport | null {
  try {
    const report = JSON.parse(value) as SshRemoteHookConfigReport;
    return report
      && ["claude", "codex"].includes(report.source)
      && ["notInstalled", "partialInstalled", "outdated", "installed", "conflict"].includes(report.status)
      && Array.isArray(report.configFiles)
      ? report
      : null;
  } catch {
    return null;
  }
}
