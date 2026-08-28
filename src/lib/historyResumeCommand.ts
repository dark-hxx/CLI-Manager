import { resolveCliToolHistorySourceId } from "./cliTools";
import { appendResumeCliArgs } from "./projectStartupCommand";
import { isValidGrokSessionId, isValidKimiSessionId, stripKimiResumeCliArgs } from "./resumeCliArgs";
import type { RemoteHandoffAgent } from "./remoteHandoff";
import type { HistorySessionSummary, Project } from "./types";

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

export function buildRemoteHandoffResumeCommand(
  agent: RemoteHandoffAgent,
  sessionId: string,
  project?: ResumeProject | null,
): string | null {
  const normalizedId = agent === "opencode"
    ? normalizeOpenCodeSessionId(sessionId)
    : normalizeSessionId(sessionId);
  if (!normalizedId) return null;

  if (agent === "codex") {
    return appendResumeCliArgs(
      `codex resume --no-alt-screen ${normalizedId}`,
      "codex",
      project,
      { includeProviderOverrides: false },
    );
  }
  if (agent === "claude") {
    return appendResumeCliArgs(
      `claude --resume ${normalizedId}`,
      "claude",
      project,
      { includeProviderOverrides: false },
    );
  }
  return appendSessionCliArgs(`${agent} --session ${normalizedId}`, agent, project);
}

export function buildHistoryResumeCommand(
  session: Pick<HistorySessionSummary, "session_id" | "source">,
  project?: ResumeProject | null,
): string | null {
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
