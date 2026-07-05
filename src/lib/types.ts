export interface Group {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  group_name: string;
  group_id: string | null;
  sort_order: number;
  cli_tool: string;
  /** CLI 附加启动参数（自由文本，整串透传），仅 cli_tool 分支生效 */
  cli_args: string;
  startup_cmd: string;
  env_vars: string;
  shell: string;
  provider_overrides: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  name: string;
  path: string;
  group_id?: string | null;
  group_name?: string;
  cli_tool?: string;
  cli_args?: string;
  startup_cmd?: string;
  env_vars?: string;
  shell?: string;
  provider_overrides?: string;
}

export interface UpdateProjectInput {
  name?: string;
  path?: string;
  group_id?: string | null;
  group_name?: string;
  sort_order?: number;
  cli_tool?: string;
  cli_args?: string;
  startup_cmd?: string;
  env_vars?: string;
  shell?: string;
  provider_overrides?: string;
}

export interface CreateGroupInput {
  name: string;
  parent_id?: string | null;
}

export type TreeNode =
  | { type: "group"; group: Group; children: TreeNode[] }
  | { type: "project"; project: Project };

export type TerminalSessionKind = "pty" | "subagent-transcript" | "file-editor" | "synced-history";

export type SubagentTranscriptSourceKind = "pending" | "child-jsonl" | "parent-jsonl" | "lifecycle-only";

export interface SubagentTranscriptSource {
  kind: SubagentTranscriptSourceKind;
  transcriptPath?: string;
  parentTranscriptPath?: string;
  reason?: string;
}

export interface SyncedHistoryPaneSession {
  key: string;
  source: HistorySource;
  sessionId: string;
  projectKey: string;
  filePath: string;
  projectName: string;
  cwd: string;
  title: string;
  startupCmd: string;
  updatedAt: number;
}

export interface TerminalSession {
  id: string;
  projectId?: string;
  title: string;
  // 重建 PTY 必需参数
  cwd?: string;
  shell?: string | null;
  envVars?: Record<string, string>;
  startupCmd?: string;
  /** 终端首次挂载时写入 xterm scrollback 的本地文本，不发送到 PTY。 */
  initialTerminalOutput?: string;
  /** true 时启动命令由 XTermTerminal 在 initialTerminalOutput 写完后再发送。 */
  deferStartupUntilInitialOutput?: boolean;
  cliSessionId?: string;
  /** CLI hook 上报的当前 effort，仅用于实时统计展示，不作为历史解析来源。 */
  cliReasoningEffort?: string;
  /** 会话类型；缺省视为 "pty"。"subagent-transcript" 为只读转录伪会话（无 PTY、不持久化）。 */
  kind?: TerminalSessionKind;
  /** 仅 kind="subagent-transcript" 时存在：子 Agent 元数据。 */
  subagent?: {
    parentSessionId: string;
    agentId?: string;
    toolUseId?: string;
    agentType?: string;
    source?: SubagentTranscriptSource;
  };
  /** 仅 kind="file-editor" 时存在：项目文件编辑器伪会话（无 PTY、不持久化）。 */
  fileEditor?: {
    projectId: string;
    projectPath: string;
    projectName: string;
    project: Project;
  };
  /** 仅 kind="synced-history" 时存在：同步历史终端（有 PTY、不持久化）。 */
  syncedHistory?: {
    key: string;
    title: string;
    cwd: string;
    sessions: SyncedHistoryPaneSession[];
  };
}

export interface ProjectFileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  sizeBytes: number;
  modifiedMs?: number | null;
  children?: ProjectFileEntry[];
}

export type ProjectFileSearchMode = "files" | "content";

export interface ProjectFileContentMatch {
  path: string;
  name: string;
  lineNumber: number;
  lineText: string;
  before: string[];
  after: string[];
}

export interface ProjectTextFilePayload {
  content: string;
  sizeBytes: number;
}

export interface ProjectImageFilePayload {
  dataBase64: string;
  mimeType: string;
  sizeBytes: number;
}

export type ProjectFilePreviewKind = "empty" | "text" | "markdown" | "image" | "unsupported";

export interface PersistedSplit {
  primarySessionIndex: number;
  direction: "horizontal" | "vertical";
  secondSessionCwd?: string;
  secondSessionShell?: string | null;
  ratio: number;
}

export interface CommandTemplate {
  id: string;
  project_id: string | null;
  session_id?: string | null;
  name: string;
  command: string;
  description: string;
  sort_order: number;
}

export interface CreateTemplateInput {
  project_id?: string | null;
  session_id?: string | null;
  name: string;
  command: string;
  description?: string;
}

export interface UpdateTemplateInput {
  name?: string;
  command?: string;
  description?: string;
  sort_order?: number;
}

export interface CommandHistoryEntry {
  id: string;
  project_id: string | null;
  command: string;
  executed_at: string;
}

export type HistorySource = "claude" | "codex";
export type HistorySourceFilter = "all" | HistorySource;
export type CcusageSource = "all" | "claude" | "codex";

export interface HistorySessionSummary {
  session_id: string;
  source: HistorySource;
  project_key: string;
  title: string;
  file_path: string;
  cwd?: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
  branch?: string | null;
}

export interface HistoryMessage {
  role: string;
  content: string;
  timestamp?: string | null;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
}

export interface HistoryToolCount {
  name: string;
  count: number;
}

export interface HistoryToolEvent {
  call_id?: string | null;
  name: string;
  category: string;
  message_index?: number | null;
  timestamp?: string | null;
  status?: string | null;
  duration_ms?: number | null;
  input_summary?: string | null;
  output_summary?: string | null;
}

export interface HistoryFileChangeOperation {
  source: string;
  tool_name?: string | null;
  file_path: string;
  old_text?: string | null;
  new_text?: string | null;
  patch?: string | null;
  additions: number;
  deletions: number;
  message_index?: number | null;
  operation_group_index?: number | null;
  timestamp?: string | null;
}

export interface HistoryFileChangeSummary {
  file_path: string;
  status: string;
  additions: number;
  deletions: number;
  latest_message_index?: number | null;
  latest_operation_group_index?: number | null;
  latest_timestamp?: string | null;
  operations: HistoryFileChangeOperation[];
}

export interface HistoryTokenTrendPoint {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  model?: string | null;
}

export interface HistorySessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  dominant_model?: string | null;
  current_model?: string | null;
  context_window?: number | null;
  last_context_tokens?: number | null;
  reasoning_effort?: string | null;
  token_trend: HistoryTokenTrendPoint[];
  tool_call_count?: number;
  mcp_calls?: HistoryToolCount[];
  skill_calls?: HistoryToolCount[];
  builtin_calls?: HistoryToolCount[];
}

export interface HistorySessionDetail extends HistorySessionSummary {
  cwd?: string | null;
  usage?: HistorySessionUsage;
  tool_events?: HistoryToolEvent[];
  file_changes?: HistoryFileChangeSummary[];
  messages: HistoryMessage[];
}

export interface HistorySearchHit {
  session_id: string;
  source: HistorySource;
  project_key: string;
  title: string;
  file_path: string;
  role: string;
  snippet: string;
  timestamp?: string | null;
}

export type PromptScope = "global" | "project" | "session";

export interface HistoryPromptItem {
  session_id: string;
  source: HistorySource;
  project_key: string;
  file_path: string;
  session_title: string;
  updated_at: number;
  message_index: number;
  prompt: string;
  timestamp?: string | null;
}

export interface SessionMeta {
  session_key: string;
  session_id: string;
  source: HistorySource;
  project_key: string;
  file_path: string;
  alias: string;
  starred: number;
  tags_json: string;
  updated_at: string;
}

export interface SessionFavoriteSnapshot {
  session_key: string;
  session_id: string;
  source: HistorySource;
  project_key: string;
  file_path: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  branch?: string | null;
  detail_json: string;
  snapshot_at: string;
}

export interface HistorySessionView extends HistorySessionSummary {
  sessionKey: string;
  alias: string;
  starred: boolean;
  tags: string[];
  displayTitle: string;
  favoriteSnapshot?: boolean;
}

export interface HistoryStatsProjectItem {
  project_key: string;
  sessions: number;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  unpriced_tokens: number;
}

export interface HistoryStatsModelItem {
  model: string;
  sessions: number;
  ratio: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  unpriced_tokens: number;
}

export interface HistoryStatsHeatmapDay {
  day_start_utc: number;
  sessions: number;
  messages: number;
  level: number;
  session_refs: HistorySessionSummary[];
}

export interface HistoryStatsDailySeriesItem {
  day_start_utc: number;
  sessions: number;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  unpriced_tokens: number;
}

export interface HistoryStatsSourceItem {
  source: string;
  sessions: number;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  unpriced_tokens: number;
}

export interface HistoryStatsProjectEfficiencyItem {
  project_key: string;
  sessions: number;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  unpriced_tokens: number;
  avg_messages_per_session: number;
}

export interface HistoryStatsHourlyActivityItem {
  hour: number;
  hour_start_utc: number;
  sessions: number;
  messages: number;
  level: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  unpriced_tokens: number;
  session_refs: HistorySessionSummary[];
}

export interface HistoryStatsPayload {
  range_days: number;
  total_sessions: number;
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  total_unpriced_tokens: number;
  project_ranking: HistoryStatsProjectItem[];
  model_distribution: HistoryStatsModelItem[];
  heatmap: HistoryStatsHeatmapDay[];
  daily_series: HistoryStatsDailySeriesItem[];
  source_distribution: HistoryStatsSourceItem[];
  project_efficiency: HistoryStatsProjectEfficiencyItem[];
  hourly_activity: HistoryStatsHourlyActivityItem[];
}

export const SHELL_OPTIONS_WINDOWS = [
  { value: "powershell", label: "PowerShell" },
  { value: "cmd", label: "CMD" },
  { value: "pwsh", label: "PowerShell Core" },
  { value: "wsl", label: "WSL" },
  { value: "gitbash", label: "Git Bash" },
  { value: "bash", label: "Bash" },
] as const;

export const SHELL_OPTIONS_MACOS = [
  { value: "zsh", label: "Zsh" },
  { value: "bash", label: "Bash" },
  { value: "fish", label: "Fish" },
  { value: "sh", label: "Sh" },
] as const;

export const SHELL_OPTIONS_LINUX = [
  { value: "bash", label: "Bash" },
  { value: "zsh", label: "Zsh" },
  { value: "fish", label: "Fish" },
  { value: "sh", label: "Sh" },
] as const;

export type ShellOption = { value: string; label: string };

/** 根据操作系统返回可选的 Shell 列表 */
export function getShellOptions(os: "windows" | "macos" | "linux" | "unknown"): readonly ShellOption[] {
  if (os === "macos") return SHELL_OPTIONS_MACOS;
  if (os === "linux") return SHELL_OPTIONS_LINUX;
  return SHELL_OPTIONS_WINDOWS;
}

/** @deprecated 使用 getShellOptions(os) 以支持跨平台 */
export const SHELL_OPTIONS = SHELL_OPTIONS_WINDOWS;

// Git 相关类型
export interface GitFileChange {
  path: string;
  status: "M" | "A" | "D" | "R" | "U" | "??" | "C";
  staged: boolean;
  added: number;
  deleted: number;
}

/** 拉取策略：合并 / 变基 / 仅快进（对应后端 git_pull strategy 入参）。 */
export type GitPullStrategy = "merge" | "rebase" | "ff-only";

export interface GitTreeNode {
  type: "file" | "directory";
  name: string;
  path: string;
  children?: GitTreeNode[];
  change?: GitFileChange;
  /** 标识该节点是否为模块根节点（Group By Module 模式下使用） */
  isModuleRoot?: boolean;
}

/** Git 变更树分组模式 */
export type GitGroupByMode = "directory" | "module";

// 当前分支与远端跟踪状态（对应后端 git_branch_status）
export interface GitBranchStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  detached: boolean;
  /** 进行中的操作："merge" / "rebase"；无则 null。驱动冲突横幅与「中止/继续」入口。 */
  pendingOp: "merge" | "rebase" | null;
}
