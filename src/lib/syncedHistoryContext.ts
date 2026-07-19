import { invoke } from "@tauri-apps/api/core";
import { getCliManagerDataPaths } from "./appPaths";
import { sourceLabel, type SyncedHistoryGroup } from "./externalSessionGrouping";
import { getHistoryPathArgs } from "./historyPathArgs";
import { getOsPlatform, normalizeShellKey } from "./shell";
import type { HistoryMessage, HistorySessionDetail } from "./types";

const CONTEXT_DIR_NAME = "synced-history-context";
const MAX_CONTEXT_SESSIONS = 5;
const MAX_MESSAGES_PER_SESSION = 12;
const MAX_MESSAGE_CHARS = 1200;
const MAX_CONTEXT_CHARS = 18000;
const MAX_CODEX_CONTEXT_CHARS = 6000;
const CLAUDE_CONTEXT_ARG_PATTERN = /(^|\s)--(?:append-)?system-prompt(?:-file)?(?:\s|=|$)/i;
const CODEX_CONTEXT_ARG_PATTERN = /(^|\s)(?:-c|--config)(?:\s+|=)(?:\(\s*)?["']?developer_instructions\s*=/i;

function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeRole(role: string): string {
  const value = role.trim().toLowerCase();
  if (value.includes("user") || value.includes("human")) return "User";
  if (value.includes("assistant") || value.includes("model")) return "Assistant";
  if (value.includes("system")) return "System";
  if (value.includes("tool")) return "Tool";
  return value || "Message";
}

function compactText(value: string, maxChars = MAX_MESSAGE_CHARS): string {
  const normalized = value
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}

function formatTime(ms: number): string {
  if (!ms) return "";
  const millis = ms > 1_000_000_000_000 ? ms : ms * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function safeFileName(group: SyncedHistoryGroup): string {
  const source = group.sessions[0]?.source ?? "claude";
  const fingerprint = hashString(`${group.key}:${group.updatedAt}:${group.sessions.map((session) => session.key).join("|")}`);
  return `${source}-${fingerprint}.md`;
}

function nativeJoin(basePath: string, ...parts: string[]): string {
  const separator = basePath.includes("\\") && !basePath.includes("/") ? "\\" : "/";
  const base = basePath.replace(/[\\/]+$/g, "");
  return [base, ...parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ""))].join(separator);
}

function shellQuoteArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function posixSingleQuoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function powerShellSingleQuoteArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function base64Utf16Le(value: string): string {
  let binary = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    binary += String.fromCharCode(code & 0xff, code >> 8);
  }
  return btoa(binary);
}

function windowsPathToWsl(path: string): string | null {
  const trimmed = path.trim();
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed);
  if (!match) return null;
  const drive = match[1].toLowerCase();
  const tail = match[2].replace(/\\/g, "/").replace(/^\/+/, "");
  return tail ? `/mnt/${drive}/${tail}` : `/mnt/${drive}`;
}

function windowsPathToGitBash(path: string): string | null {
  const trimmed = path.trim();
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed);
  if (!match) return null;
  const drive = match[1].toLowerCase();
  const tail = match[2].replace(/\\/g, "/").replace(/^\/+/, "");
  return tail ? `/${drive}/${tail}` : `/${drive}`;
}

function contextPathForShell(path: string, shell?: string | null): string {
  const normalizedShell = normalizeShellKey(shell);
  if (normalizedShell === "gitbash") return windowsPathToGitBash(path) ?? path;
  if (normalizedShell !== "wsl" && normalizedShell !== "bash") return path;
  return windowsPathToWsl(path) ?? path;
}

function capContext(value: string, maxChars = MAX_CONTEXT_CHARS): string {
  if (value.length <= maxChars) return value;
  const keepTailChars = Math.max(0, maxChars - 800);
  return [
    value.slice(0, 700).trimEnd(),
    "",
    "...[Earlier imported history omitted to keep startup context compact]...",
    "",
    value.slice(-keepTailChars).trimStart(),
  ].join("\n");
}

function pickMessages(messages: HistoryMessage[]): HistoryMessage[] {
  return messages
    .filter((message) => {
      const role = normalizeRole(message.role);
      return role === "User" || role === "Assistant";
    })
    .slice(-MAX_MESSAGES_PER_SESSION);
}

function formatSessionContext(detail: HistorySessionDetail): string {
  const lines: string[] = [];
  const title = detail.title?.trim() || detail.session_id;
  lines.push(`## Session: ${title}`);
  const updatedAt = formatTime(asNumber(detail.updated_at));
  if (updatedAt) lines.push(`Updated: ${updatedAt}`);
  if (detail.cwd) lines.push(`Directory: ${detail.cwd}`);
  if (detail.file_changes?.length) {
    lines.push("Touched files:");
    for (const item of detail.file_changes.slice(0, 12)) {
      lines.push(`- ${item.file_path} (${item.status}, +${item.additions}/-${item.deletions})`);
    }
  }
  const messages = pickMessages(detail.messages ?? []);
  if (messages.length) {
    lines.push("Recent conversation:");
    for (const message of messages) {
      const content = compactText(message.content);
      if (!content) continue;
      lines.push(`- ${normalizeRole(message.role)}: ${content}`);
    }
  }
  return lines.join("\n");
}

async function readSessionDetail(session: SyncedHistoryGroup["sessions"][number]): Promise<HistorySessionDetail | null> {
  try {
    return await invoke<HistorySessionDetail>("history_get_session", {
      filePath: session.filePath,
      ...(await getHistoryPathArgs()),
      source: session.source,
      projectKey: session.projectKey,
      aggregateSubtasks: false,
    });
  } catch {
    return null;
  }
}

export function supportsHiddenSyncedHistoryContext(group: SyncedHistoryGroup): boolean {
  const source = group.sessions[0]?.source;
  return source === "claude" || source === "codex";
}

export async function buildSyncedHistoryContext(group: SyncedHistoryGroup): Promise<string | null> {
  if (!supportsHiddenSyncedHistoryContext(group)) return null;
  const source = group.sessions[0]?.source ?? "claude";
  const selectedSessions = [...group.sessions]
    .filter((session) => session.source === source)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONTEXT_SESSIONS)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  if (selectedSessions.length === 0) return null;

  const details = (await Promise.all(selectedSessions.map(readSessionDetail)))
    .filter((detail): detail is HistorySessionDetail => Boolean(detail));
  if (details.length === 0) return null;

  const header = [
    `You are starting a clean ${sourceLabel(source)} session inside CLI-Manager.`,
    `The following content is imported background from previous ${sourceLabel(source)} sessions for this same project.`,
    "Use it silently as context for the user's future requests. Do not repeat it or mention it unless the user asks.",
    "",
    `Project: ${group.name}`,
    `Source: ${sourceLabel(source)}`,
    group.cwd ? `Directory: ${group.cwd}` : "",
    `Imported sessions included: ${details.length}`,
    "",
  ].filter(Boolean).join("\n");
  return capContext(`${header}${details.map(formatSessionContext).join("\n\n")}`, source === "codex" ? MAX_CODEX_CONTEXT_CHARS : MAX_CONTEXT_CHARS);
}

export async function writeSyncedHistoryContextFile(group: SyncedHistoryGroup): Promise<string | null> {
  const context = await buildSyncedHistoryContext(group);
  if (!context) return null;
  const paths = await getCliManagerDataPaths();
  try {
    await invoke("file_create_dir", {
      rootPath: paths.dataDir,
      parentPath: "",
      name: CONTEXT_DIR_NAME,
      overwrite: false,
    });
  } catch (err) {
    if (!String(err).includes("target_exists")) throw err;
  }
  const fileName = safeFileName(group);
  await invoke("file_write_text", {
    rootPath: paths.dataDir,
    relativePath: `${CONTEXT_DIR_NAME}/${fileName}`,
    content: context,
  });
  return nativeJoin(paths.dataDir, CONTEXT_DIR_NAME, fileName);
}

async function writeCodexSyncedHistoryContextTextFile(group: SyncedHistoryGroup): Promise<string | null> {
  const context = await buildSyncedHistoryContext(group);
  if (!context) return null;
  const paths = await getCliManagerDataPaths();
  try {
    await invoke("file_create_dir", {
      rootPath: paths.dataDir,
      parentPath: "",
      name: CONTEXT_DIR_NAME,
      overwrite: false,
    });
  } catch (err) {
    if (!String(err).includes("target_exists")) throw err;
  }
  const fileName = safeFileName(group).replace(/\.md$/i, ".txt");
  await invoke("file_write_text", {
    rootPath: paths.dataDir,
    relativePath: `${CONTEXT_DIR_NAME}/${fileName}`,
    content: context,
  });
  return nativeJoin(paths.dataDir, CONTEXT_DIR_NAME, fileName);
}

function codexDeveloperInstructionsArgFromFile(path: string, shell?: string | null): string {
  const normalizedShell = normalizeShellKey(shell);
  if (normalizedShell === "powershell" || normalizedShell === "pwsh") {
    return `-c ("developer_instructions=" + (Get-Content -Raw -LiteralPath ${powerShellSingleQuoteArg(path)}))`;
  }
  if (normalizedShell === "fish") {
    return `-c "developer_instructions="(cat ${posixSingleQuoteArg(contextPathForShell(path, shell))} | string collect)`;
  }
  return `-c "developer_instructions=$(cat ${posixSingleQuoteArg(contextPathForShell(path, shell))})"`;
}

function codexCommandWithDeveloperInstructions(startupCmd: string, path: string, shell?: string | null): string {
  const normalizedShell = normalizeShellKey(shell);
  if (normalizedShell !== "cmd") {
    return `${startupCmd} ${codexDeveloperInstructionsArgFromFile(path, shell)}`;
  }

  const script = [
    `$context = Get-Content -Raw -LiteralPath ${powerShellSingleQuoteArg(path)}`,
    `${startupCmd} -c ('developer_instructions=' + $context)`,
  ].join("\n");
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${base64Utf16Le(script)}`;
}

export async function appendClaudeSyncedHistoryContextArg(
  startupCmd: string | undefined,
  group: SyncedHistoryGroup | null | undefined,
  shell?: string | null
): Promise<string | undefined> {
  return appendSyncedHistoryContextArg("claude", startupCmd, group, shell);
}

export async function appendSyncedHistoryContextArg(
  tool: string | undefined,
  startupCmd: string | undefined,
  group: SyncedHistoryGroup | null | undefined,
  shell?: string | null
): Promise<string | undefined> {
  if (!startupCmd || !group || !supportsHiddenSyncedHistoryContext(group)) return startupCmd;
  const source = group.sessions[0]?.source;
  const normalizedTool = tool?.trim().toLowerCase();
  if (!source || normalizedTool !== source) return startupCmd;

  if (source === "codex") {
    if (CODEX_CONTEXT_ARG_PATTERN.test(startupCmd)) return startupCmd;
    const contextPath = await writeCodexSyncedHistoryContextTextFile(group);
    if (!contextPath) return startupCmd;
    const effectiveShell = shell ?? ((await getOsPlatform()) === "windows" ? "powershell" : undefined);
    return codexCommandWithDeveloperInstructions(startupCmd, contextPath, effectiveShell);
  }

  if (CLAUDE_CONTEXT_ARG_PATTERN.test(startupCmd)) return startupCmd;
  const contextPath = await writeSyncedHistoryContextFile(group);
  if (!contextPath) return startupCmd;
  return `${startupCmd} --append-system-prompt-file ${shellQuoteArg(contextPathForShell(contextPath, shell))}`;
}
