import { resolveCliToolHistorySourceId } from "../../../shared/lib/cliTools";
import { isAgySessionId, buildAgyResumeCommand } from "../../projects/api/agyStartupCommand";
import { sameAgyCwd } from "../../projects/api/agySessionLocation";
import { parseWslPath } from "../../../shared/lib/wslPaths";
import { historyPathsMatch } from "../lib/historyResumeEnvironment";
import { appendResumeCliArgs } from "../../projects/api/projectStartupCommand";
import { isValidGrokSessionId, isValidKimiSessionId, stripKimiResumeCliArgs } from "./resumeCliArgs";
import type { HistorySessionSummary, Project } from "../../../shared/types/index";

type ResumeProject = Pick<
  Project,
  "cli_tool" | "cli_args" | "startup_cmd" | "provider_overrides" | "shell"
>;

const PI_RESUME_OPTIONS = new Set([
  "-c",
  "-r",
  "--continue",
  "--resume",
  "--session",
  "--session-id",
  "--fork",
]);

const OPENCODE_RESUME_OPTIONS = new Set([
  "-c",
  "--continue",
  "-s",
  "--session",
  "--fork",
]);

const OPENCODE_RESUME_OPTIONS_WITH_VALUE = new Set([
  "-s",
  "--session",
  "-c",
  "--continue",
  "--fork",
]);

interface CliArgToken {
  raw: string;
  normalized: string;
}

function tokenizeCliArgs(value: string): CliArgToken[] {
  const tokens: CliArgToken[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index])) index += 1;
    if (index >= value.length) break;
    const start = index;
    let quote: "\"" | "'" | null = null;
    while (index < value.length) {
      const char = value[index];
      if (quote) {
        if (char === "\\" && index + 1 < value.length) {
          index += 2;
          continue;
        }
        if (char === quote) quote = null;
        index += 1;
        continue;
      }
      if (char === "\"" || char === "'") {
        quote = char;
        index += 1;
        continue;
      }
      if (/\s/.test(char)) break;
      index += 1;
    }
    const raw = value.slice(start, index);
    tokens.push({ raw, normalized: raw.toLowerCase() });
  }
  return tokens;
}

function optionName(token: CliArgToken): string {
  const equalsIndex = token.normalized.indexOf("=");
  return equalsIndex < 0 ? token.normalized : token.normalized.slice(0, equalsIndex);
}

export function stripOpenCodeResumeCliArgs(cliArgs: string | null | undefined): string {
  const tokens = tokenizeCliArgs(cliArgs ?? "");
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!OPENCODE_RESUME_OPTIONS.has(optionName(token))) {
      kept.push(token.raw);
      continue;
    }
    if (
      OPENCODE_RESUME_OPTIONS_WITH_VALUE.has(optionName(token))
      && !token.raw.includes("=")
      && tokens[index + 1]
      && !tokens[index + 1].raw.startsWith("-")
    ) {
      index += 1;
    }
  }
  return kept.join(" ").trim();
}

export function stripPiResumeCliArgs(cliArgs: string | null | undefined): string {
  const tokens = tokenizeCliArgs(cliArgs ?? "");
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!PI_RESUME_OPTIONS.has(optionName(token))) {
      kept.push(token.raw);
      continue;
    }
    if (!token.raw.includes("=") && tokens[index + 1] && !tokens[index + 1].raw.startsWith("-")) {
      index += 1;
    }
  }
  return kept.join(" ").trim();
}

export { stripKimiResumeCliArgs };

function normalizeSessionId(sessionId: string): string | null {
  const trimmed = sessionId.trim();
  return trimmed && !/[\s\0\r\n]/.test(trimmed) ? trimmed : null;
}

function normalizeOpenCodeSessionId(sessionId: string): string | null {
  const normalized = normalizeSessionId(sessionId);
  return normalized && /^ses_[A-Za-z0-9]+$/.test(normalized) ? normalized : null;
}

function appendSessionCliArgs(
  base: string,
  source: "pi" | "opencode",
  project?: ResumeProject | null,
): string {
  if (
    !project
    || project.startup_cmd.trim()
    || resolveCliToolHistorySourceId(project.cli_tool) !== source
  ) {
    return base;
  }
  const cliArgs = source === "opencode"
    ? stripOpenCodeResumeCliArgs(project.cli_args)
    : stripPiResumeCliArgs(project.cli_args);
  return cliArgs ? `${base} ${cliArgs}` : base;
}

type ResumeRecord = Pick<HistorySessionSummary, "session_id" | "source"> & Partial<HistorySessionSummary> & { favoriteSnapshot?: boolean };

// Existing sources keep their descriptor-level contract. agy has a second read-only
// legacy root with UUID-shaped names, so a source capability alone cannot authorize it.
export function hasResumeProvenance(session: ResumeRecord): boolean {
  if (session.source !== "antigravity") return true;
  const id = session.session_id;
  const path = (session.file_path ?? "").replace(/\\/g, "/");
  const cwd = session.cwd?.trim();
  const ref = session.session_ref;
  if (!isAgySessionId(id) || !cwd || !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(cwd)
    || session.favoriteSnapshot || session.read_only || session.remote_identity
    || (session.freshness_state && session.freshness_state !== "fresh")
    || (ref && (!["local", "wsl"].includes(ref.transportKind) || ref.sourceId !== session.source || ref.sourceSessionId !== id))
    || /[\x00-\x1f]/.test(path + cwd) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)
    || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(cwd)) return false;
  const wsl = parseWslPath(path);
  const native = path.replace(/^\/\/\?\/([A-Za-z]:\/)/, "$1");
  if (!(wsl || /^(?:[a-z]:\/|\/(?!\/))/i.test(native)) || (ref && (ref.transportKind === "wsl") !== Boolean(wsl))) return false;
  if (ref && (!ref.sourceInstanceId?.trim() || !Array.isArray(ref.rawPointers) || !ref.rawPointers.length || ref.rawPointers.some((item) => {
    const rawKey = item?.rawKey;
    if (typeof rawKey !== "string" || !rawKey.trim()) return true;
    const pointer = parseWslPath(rawKey);
    if (Boolean(wsl) !== Boolean(pointer)) return true;
    return !sameAgyCwd(path, rawKey, wsl?.distro);
  }))) return false;
  const suffix = `/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`;
  return !wsl && /^[a-z]:\//i.test(native)
    ? native.toLowerCase().endsWith(suffix.toLowerCase()) : (wsl?.linuxPath ?? native).endsWith(suffix);
}

// Last gate before PTY creation: the picker/cache is not proof of an existing,
// authorized file or of today's workspace mapping. Re-read using scoped fresh detail.
export async function verifyAgyHistoryTarget(
  session: ResumeRecord, project: Project | null, worktreePath: string | undefined,
  launch: { cwd: string; shell?: string },
  readFresh: () => Promise<ResumeRecord>,
  isDirectory: (path: string) => Promise<boolean>,
): Promise<void> {
  const wsl = parseWslPath(session.file_path);
  const dest = parseWslPath(launch.cwd);
  if (!hasResumeProvenance(session) || Boolean(wsl) !== (launch.shell === "wsl")
    || wsl?.distro.toLowerCase() !== dest?.distro.toLowerCase()
    || !sameAgyCwd(session.cwd!, launch.cwd, wsl?.distro)
    || (project && !historyPathsMatch(session, { ...project, path: worktreePath || project.path }))) {
    throw new Error("history_resume_environment_mismatch");
  }
  const fresh = await readFresh();
  if (!hasResumeProvenance(fresh) || fresh.source !== session.source || fresh.session_id !== session.session_id
    || fresh.session_ref?.sourceInstanceId !== session.session_ref?.sourceInstanceId
    || fresh.session_ref?.transportKind !== session.session_ref?.transportKind
    || fresh.file_path !== session.file_path || fresh.cwd !== session.cwd || !(await isDirectory(launch.cwd))) {
    throw new Error("history_resume_source_or_cwd_changed");
  }
}

export function buildHistoryResumeCommand(
  session: ResumeRecord,
  project?: ResumeProject | null,
): string | null {
  if (session.source === "antigravity") {
    return hasResumeProvenance(session) ? buildAgyResumeCommand(session.session_id, project) : null;
  }
  const sessionId = session.source === "opencode"
    ? normalizeOpenCodeSessionId(session.session_id)
    : normalizeSessionId(session.session_id);
  if (!sessionId) return null;
  if (session.source === "kimi" && !isValidKimiSessionId(sessionId)) return null;
  if (session.source === "grok" && !isValidGrokSessionId(sessionId)) return null;

  if (session.source === "opencode") {
    return appendSessionCliArgs(`opencode --session ${sessionId}`, "opencode", project);
  }
  if (session.source === "pi") {
    return appendSessionCliArgs(`pi --session ${sessionId}`, "pi", project);
  }
  if (session.source === "claude") {
    return appendResumeCliArgs(`claude --resume ${sessionId}`, "claude", project);
  }
  if (session.source === "codex") {
    return appendResumeCliArgs(`codex resume ${sessionId}`, "codex", project);
  }
  if (session.source === "grok") {
    return appendResumeCliArgs(`grok --resume ${sessionId}`, "grok", project);
  }
  if (session.source === "kimi") {
    return appendResumeCliArgs(`kimi --session ${sessionId}`, "kimi", project);
  }
  return null;
}
