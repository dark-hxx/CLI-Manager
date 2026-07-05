import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";
import { getCliManagerDataPaths } from "./appPaths";
import { resolveProjectStartupCommand } from "./projectStartupCommand";
import type { HistoryMessage, HistorySessionDetail, HistorySource, Project } from "./types";
import type { SyncedExternalSession } from "../stores/externalSessionSyncStore";
import { sourceLabel, sourceTool, type SyncedHistoryGroup } from "./externalSessionGrouping";

const SYNC_CONTEXT_DIR = ".cli-manager/synced-history";
const HISTORY_REINDEX_LOOKUP_LIMIT = 5000;

interface HistorySessionSummaryLike {
  session_id?: unknown;
  sessionId?: unknown;
  source?: unknown;
  project_key?: unknown;
  projectKey?: unknown;
  file_path?: unknown;
  filePath?: unknown;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeRole(raw: unknown): string {
  const value = asString(raw).trim().toLowerCase();
  if (!value) return "assistant";
  if (value.includes("user") || value.includes("human")) return "user";
  if (value.includes("assistant") || value.includes("model") || value.includes("llm")) return "assistant";
  if (value.includes("system")) return "system";
  if (value.includes("tool")) return "tool";
  return value;
}

function normalizeDetail(raw: unknown): HistorySessionDetail {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const messagesRaw = Array.isArray(rec.messages) ? rec.messages : [];
  const messages: HistoryMessage[] = messagesRaw.map((msg) => {
    const m = msg as Record<string, unknown>;
    return {
      role: normalizeRole(m.role),
      content: asString(m.content),
      timestamp: asString(m.timestamp ?? "") || null,
      model: asString(m.model ?? "") || undefined,
      input_tokens: asNumber(m.input_tokens ?? m.inputTokens),
      output_tokens: asNumber(m.output_tokens ?? m.outputTokens),
      cache_creation_tokens: asNumber(m.cache_creation_tokens ?? m.cacheCreationTokens),
      cache_read_tokens: asNumber(m.cache_read_tokens ?? m.cacheReadTokens),
    };
  });

  return {
    session_id: asString(rec.session_id ?? rec.sessionId),
    source: asString(rec.source) as HistorySessionDetail["source"],
    project_key: asString(rec.project_key ?? rec.projectKey),
    title: asString(rec.title),
    file_path: asString(rec.file_path ?? rec.filePath),
    cwd: asString(rec.cwd ?? "") || null,
    created_at: asNumber(rec.created_at ?? rec.createdAt),
    updated_at: asNumber(rec.updated_at ?? rec.updatedAt),
    message_count: asNumber(rec.message_count ?? rec.messageCount),
    branch: asString(rec.branch ?? "") || null,
    messages,
  };
}

function normalizeSummary(raw: unknown): { source: HistorySource; projectKey: string; filePath: string } | null {
  const rec = (raw ?? {}) as HistorySessionSummaryLike;
  const source = asString(rec.source).trim().toLowerCase();
  if (source !== "codex" && source !== "claude") return null;
  const projectKey = asString(rec.project_key ?? rec.projectKey).trim();
  const filePath = asString(rec.file_path ?? rec.filePath).trim();
  if (!projectKey || !filePath) return null;
  return { source, projectKey, filePath };
}

function normalizePathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function formatDateTime(ms: number): string {
  if (!ms) return "-";
  return new Date(ms).toISOString();
}

function safeFilePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "synced";
}

function commandForSource(source: HistorySessionDetail["source"], project?: Project): string {
  if (!project) return sourceTool(source);
  return resolveProjectStartupCommand(
    {
      ...project,
      cli_tool: sourceTool(source),
      startup_cmd: "",
    },
    { includeCodexProviderProfile: true }
  ) ?? sourceTool(source);
}

function buildContextMarkdown(group: SyncedHistoryGroup, details: HistorySessionDetail[]): string {
  const lines: string[] = [
    `# CLI-Manager ${sourceLabel(details[0]?.source ?? group.sessions[0]?.source ?? "codex")} 同步聚合上下文`,
    "",
    `项目：${group.name}`,
    `路径：${group.cwd}`,
    `会话数：${details.length}`,
    `生成时间：${new Date().toISOString()}`,
    "",
    "下面内容来自同一个同步终端入口下的所有历史会话，按更新时间从旧到新排列。",
    "",
  ];

  for (const [sessionIndex, detail] of details.entries()) {
    lines.push(
      "---",
      "",
      `## 会话 ${sessionIndex + 1}: ${detail.title || detail.session_id}`,
      "",
      `source: ${detail.source}`,
      `session_id: ${detail.session_id}`,
      `project_key: ${detail.project_key}`,
      `cwd: ${detail.cwd ?? ""}`,
      `updated_at: ${formatDateTime(detail.updated_at)}`,
      `file_path: ${detail.file_path}`,
      ""
    );

    for (const [messageIndex, message] of detail.messages.entries()) {
      lines.push(
        `### ${messageIndex + 1}. ${message.role.toUpperCase()}${message.timestamp ? ` · ${message.timestamp}` : ""}`,
        "",
        message.content.trim() || "(empty)",
        ""
      );
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

async function ensureContextDir(rootPath: string): Promise<void> {
  await invoke("file_create_dir", {
    rootPath,
    parentPath: "",
    name: ".cli-manager",
    overwrite: false,
  }).catch(() => {});
  await invoke("file_create_dir", {
    rootPath,
    parentPath: ".cli-manager",
    name: "synced-history",
    overwrite: false,
  }).catch(() => {});
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

async function resolveExistingLaunchCwd(group: SyncedHistoryGroup, project?: Project): Promise<string> {
  const dataPaths = await getCliManagerDataPaths();
  const candidates = uniqueNonEmpty([
    project?.path,
    group.cwd,
    ...group.sessions.map((session) => session.cwd),
    dataPaths.dataDir,
  ]);
  if (candidates.length === 0) throw new Error("missing_synced_history_cwd");

  const exists = await invoke<boolean[]>("check_paths_exist", { paths: candidates });
  const index = exists.findIndex(Boolean);
  if (index >= 0) return candidates[index];

  throw new Error("missing_synced_history_cwd");
}

async function readSessionDetail(
  session: SyncedExternalSession,
  settings: ReturnType<typeof useSettingsStore.getState>
): Promise<HistorySessionDetail> {
  const args = {
    filePath: session.filePath,
    claudeConfigDir: settings.claudeHookConfigDir?.trim() || null,
    codexConfigDir: settings.codexHookConfigDir?.trim() || null,
    source: session.source,
    projectKey: session.projectKey,
    aggregateSubtasks: true,
  };

  try {
    return normalizeDetail(await invoke<unknown>("history_get_session", args));
  } catch (err) {
    if (!String(err).includes("session_file_not_indexed")) throw err;
  }

  const summaries = await invoke<unknown[]>("history_list_sessions", {
    source: session.source,
    claudeConfigDir: settings.claudeHookConfigDir?.trim() || null,
    codexConfigDir: settings.codexHookConfigDir?.trim() || null,
    projectPath: null,
    query: null,
    limit: HISTORY_REINDEX_LOOKUP_LIMIT,
    offset: 0,
  });
  const targetPath = normalizePathKey(session.filePath);
  const match = (summaries ?? [])
    .map((item) => normalizeSummary(item))
    .find((item) => item?.source === session.source && normalizePathKey(item.filePath) === targetPath);
  if (!match) throw new Error("session_file_not_indexed");

  return normalizeDetail(await invoke<unknown>("history_get_session", {
    ...args,
    projectKey: match.projectKey,
  }));
}

export async function buildSyncedHistoryStartupCommand(
  group: SyncedHistoryGroup,
  project?: Project
): Promise<{ command: string; cwd: string; prompt: string }> {
  const first = group.sessions[0];
  if (!first) throw new Error("empty_synced_history_group");

  const cwd = await resolveExistingLaunchCwd(group, project);

  const settings = useSettingsStore.getState();
  const sessions = [...group.sessions].sort((a, b) => a.updatedAt - b.updatedAt);
  const details: HistorySessionDetail[] = [];

  for (const session of sessions) {
    details.push(await readSessionDetail(session, settings));
  }

  await ensureContextDir(cwd);
  const relativePath = `${SYNC_CONTEXT_DIR}/${safeFilePart(`${first.source}-${group.key || group.name}`)}-merged.md`;
  await invoke("file_write_text", {
    rootPath: cwd,
    relativePath,
    content: buildContextMarkdown(group, details),
  });

  const prompt = [
    "这是 CLI-Manager 同步聚合会话。",
    `请先读取 ${relativePath}，把里面的所有 ${sourceLabel(first.source)} 历史记录当作本会话上下文。`,
    "读取完成后只简短回复：同步记录已加载。",
  ].join(" ");

  const baseCommand = commandForSource(first.source, project);
  const withInlineMode = first.source === "codex" && !/(^|\s)--no-alt-screen(\s|$)/.test(baseCommand)
    ? `${baseCommand} --no-alt-screen`
    : baseCommand;

  return {
    cwd,
    command: withInlineMode,
    prompt,
  };
}

export function scheduleSyncedHistoryPrompt(sessionId: string, prompt: string): void {
  window.setTimeout(() => {
    invoke("pty_write", { sessionId, data: `${prompt}\r` }).catch(() => {});
  }, 2200);
  window.setTimeout(() => {
    invoke("pty_write", { sessionId, data: "\r" }).catch(() => {});
  }, 18000);
}
