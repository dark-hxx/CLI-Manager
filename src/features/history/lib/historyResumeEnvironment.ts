import type { HistorySessionSummary, Project, WorktreeRecord } from "../../../shared/types/index";
import { parseWslPath, toWslUnc, windowsPathToLinux } from "../../../shared/lib/wslPaths";

type ResumeSession = Pick<HistorySessionSummary, "cwd" | "source" | "project_key">
  & Partial<Pick<HistorySessionSummary, "file_path" | "session_ref">>;

export function historySourceWslPath(session: Partial<HistorySessionSummary>) {
  return [session.file_path, ...(session.session_ref?.rawPointers.map((p) => p.rawKey) ?? [])]
    .map(parseWslPath).find((path) => path !== null) ?? null;
}

export function historyPathsMatch(session: Pick<HistorySessionSummary, "cwd"> & Partial<HistorySessionSummary>, project: Project): boolean {
  if (project.environment_type === "ssh" || !session.cwd) return false;
  const source = historySourceWslPath(session);
  const historyPath = parseWslPath(session.cwd);
  const projectPath = parseWslPath(project.path);
  const projectConfig = parseWslPath(project.cli_config_root);
  const distro = source?.distro ?? historyPath?.distro;
  const projectDistro = projectPath?.distro ?? projectConfig?.distro;
  if (distro && projectDistro && distro.toLowerCase() !== projectDistro.toLowerCase()) return false;
  const wsl = !!(source || historyPath || projectPath || session.session_ref?.transportKind === "wsl");
  if (wsl && project.environment_type !== "wsl" && project.shell !== "wsl" && !projectPath) return false;
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const left = normalize(historyPath?.linuxPath ?? (wsl ? windowsPathToLinux(session.cwd) : null) ?? session.cwd);
  const right = normalize(projectPath?.linuxPath ?? (wsl ? windowsPathToLinux(project.path) : null) ?? project.path);
  const windows = /^[a-z]:\//i.test(left) || left.startsWith("//");
  return !wsl && windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

const CONFIG_ENV: Record<string, string> = {
  claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", kimi: "KIMI_CODE_HOME",
  pi: "PI_CODING_AGENT_DIR", grok: "GROK_HOME", opencode: "OPENCODE_CONFIG_DIR",
};

export function resolveHistoryResumeEnvironment(
  session: ResumeSession, project: Project | null | undefined,
  worktree: WorktreeRecord | null | undefined, requestedShell: string | undefined, os: string,
): { cwd: string; shell: string | undefined; env: Record<string, string> } {
  const cwd = session.cwd?.trim() || worktree?.path || project?.path
    || (/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(session.project_key) ? session.project_key : "");
  if (!cwd) throw new Error("history_resume_cwd_missing");
  const source = historySourceWslPath(session);
  const cwdPath = parseWslPath(cwd);
  const projectPath = parseWslPath(worktree?.path) ?? parseWslPath(project?.path);
  const projectConfig = parseWslPath(project?.cli_config_root);
  const wsl = os === "windows" && (source || cwdPath || projectPath || projectConfig
    || session.session_ref?.transportKind === "wsl" || project?.environment_type === "wsl" || requestedShell === "wsl");
  if (!wsl) {
    if (os === "windows" && cwd.startsWith("/") && !cwd.startsWith("//")) {
      throw new Error("history_resume_wsl_distro_required");
    }
    return { cwd, shell: requestedShell, env: {} };
  }
  const distro = source?.distro ?? cwdPath?.distro ?? projectPath?.distro ?? projectConfig?.distro;
  if (!distro) throw new Error("history_resume_wsl_distro_required");
  for (const path of [source, cwdPath, projectPath, projectConfig]) {
    if (path && path.distro.toLowerCase() !== distro.toLowerCase()) throw new Error("history_resume_wsl_distro_conflict");
  }
  const linuxCwd = cwdPath?.linuxPath ?? windowsPathToLinux(cwd) ?? cwd;
  const env: Record<string, string> = {};
  // Session storage is the authority for custom CLI homes. OpenCode's database
  // directory is NOT its configuration directory and must not be substituted.
  const anchor = session.source === "claude" ? "/projects/" : "/sessions/";
  const sourceHome = session.source !== "opencode" && source?.linuxPath.includes(anchor)
    ? source.linuxPath.slice(0, source.linuxPath.indexOf(anchor)) : null;
  const home = sourceHome || projectConfig?.linuxPath || project?.cli_config_root?.trim();
  const key = CONFIG_ENV[session.source];
  if (home && key) {
    const linuxHome = windowsPathToLinux(home) ?? home;
    if (!linuxHome.startsWith("/")) throw new Error("history_resume_wsl_path_invalid");
    env[key] = linuxHome;
  }
  return { cwd: toWslUnc(distro, linuxCwd), shell: "wsl", env };
}
