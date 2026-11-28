import { matchAgyLauncher, isAgyCommand } from "../../../shared/lib/cliTools";

export function isAgySessionId(id: string | null | undefined): id is string {
  return !!id && id !== "00000000-0000-0000-0000-000000000000" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) && id.length === 36;
}

// Structured cli_tool may contain a quoted path; PowerShell needs its call operator.
// Free-text startup_cmd takes the normal early return and is never rewritten here.
function formatAgyLauncher(path: string, raw: string, shell?: string | null): string {
  if (/^[\w./:\\-]+$/.test(path)) return path;
  const powershell = /^(?:powershell|pwsh)$/i.test(shell ?? "") || (!shell && (/^[a-z]:/i.test(path) || /^&\s/.test(raw)));
  return `${powershell ? "& " : ""}"${path}"`;
}

export function buildAgyStartupCommand(cliTool: string, cliArgs: string, shell?: string | null): string | null {
  const match = matchAgyLauncher(cliTool);
  if (!match) return null;
  const launcher = formatAgyLauncher(match.path, match.raw, shell) + cliTool.trim().slice(match.raw.length);
  return cliArgs ? `${launcher} ${cliArgs}` : launcher;
}

// Restore is a selection, not replay of a command. Copy only known inert arguments
// from structured project settings, never arbitrary flags, prompts, shell or subcommands.
export function buildAgyResumeArgs(id: string | null | undefined, cliArgs = ""): string | null {
  if (!isAgySessionId(id)) return null;
  const kept = [`--conversation ${id}`];
  const tokens = cliArgs.match(/(?:[^\s"']+|"[^"\r\n]*"|'[^'\r\n]*')+/g) ?? [];
  if (!/[\r\n;&|<>`$%!^]/.test(cliArgs)) {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === "--") break;
      if (token === "--sandbox") kept.push(token);
      const opt = /^(--(?:effort|model))(?:=(.*))?$/.exec(token);
      if (!opt) continue;
      const value = (opt[2] ?? tokens[i + 1] ?? "").replace(/^(?:"([^"]*)"|'([^']*)')$/, "$1$2");
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value)) continue;
      if (opt[1] === "--effort" && !/^(?:low|medium|high|xhigh|max)$/.test(value)) continue;
      kept.push(opt[1], value);
      if (opt[2] === undefined) i++;
    }
  }
  return kept.join(" ");
}

type AgyProject = { cli_tool: string; cli_args: string; startup_cmd: string; shell?: string | null };

export function buildAgyResumeCommand(id: string | null | undefined, project?: AgyProject | null, previousCommand?: string, shell?: string | null): string | null {
  const configured = project?.startup_cmd?.trim() || project?.cli_tool || "agy";
  const launcher = previousCommand?.trim() || configured;
  const match = matchAgyLauncher(launcher);
  if (!match) return null;
  const args = buildAgyResumeArgs(id, !project?.startup_cmd?.trim() && isAgyCommand(project?.cli_tool) ? project?.cli_args : "");
  return args ? `${formatAgyLauncher(match.path, match.raw, shell ?? project?.shell)} ${args}` : null;
}
