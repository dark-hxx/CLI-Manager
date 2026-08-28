import type { SshHistorySource, SshRemoteHookConfigReport, SshToolSource } from "./types";

export const DEFAULT_SSH_TOOL_CONFIG_ROOT: Record<SshToolSource, string> = {
  claude: "$HOME/.claude",
  codex: "$HOME/.codex",
  kimi: "$HOME/.kimi-code",
  grok: "$HOME/.grok",
};

function firstExecutableToken(command: string): string {
  const trimmed = command.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const closingIndex = trimmed.indexOf(quote, 1);
    return closingIndex > 0 ? trimmed.slice(1, closingIndex) : "";
  }
  return trimmed.split(/\s+/, 1)[0] ?? "";
}

export function resolveSshToolSource(command: string | null | undefined): SshToolSource | null {
  const executable = firstExecutableToken(command ?? "").replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (executable === "claude" || executable === "claude.exe") return "claude";
  if (executable === "codex" || executable === "codex.exe") return "codex";
  if (["kimi", "kimi.exe", "kimi.cmd", "kimi.ps1"].includes(executable ?? "")) return "kimi";
  if (["grok", "grok.exe", "grok.cmd", "grok.ps1"].includes(executable ?? "")) return "grok";
  return null;
}

export function resolveSshHistorySource(command: string | null | undefined): SshHistorySource | null {
  const source = resolveSshToolSource(command);
  return source === "claude" || source === "codex" ? source : null;
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
    const historyCandidate = report?.installation?.historySourceCandidate;
    const historyCandidateValid = report?.source === "kimi" || report?.source === "grok"
      ? historyCandidate == null
      : report?.installation == null || historyCandidate?.source === report.source;
    return report
      && ["claude", "codex", "kimi", "grok"].includes(report.source)
      && ["notInstalled", "partialInstalled", "outdated", "installed", "conflict"].includes(report.status)
      && Array.isArray(report.configFiles)
      && historyCandidateValid
      ? report
      : null;
  } catch {
    return null;
  }
}
