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
  startup_cmd: string;
  env_vars: string;
  shell: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  name: string;
  path: string;
  group_id?: string | null;
  group_name?: string;
  cli_tool?: string;
  startup_cmd?: string;
  env_vars?: string;
  shell?: string;
}

export interface UpdateProjectInput {
  name?: string;
  path?: string;
  group_id?: string | null;
  group_name?: string;
  sort_order?: number;
  cli_tool?: string;
  startup_cmd?: string;
  env_vars?: string;
  shell?: string;
}

export interface CreateGroupInput {
  name: string;
  parent_id?: string | null;
}

export type TreeNode =
  | { type: "group"; group: Group; children: TreeNode[] }
  | { type: "project"; project: Project };

export interface TerminalSession {
  id: string;
  projectId?: string;
  title: string;
  // 重建 PTY 必需参数
  cwd?: string;
  shell?: string | null;
  envVars?: Record<string, string>;
  startupCmd?: string;
  cliSessionId?: string;
}

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

export interface HistoryTokenTrendPoint {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
}

export interface HistorySessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  dominant_model?: string | null;
  context_window?: number | null;
  last_context_tokens?: number | null;
  token_trend: HistoryTokenTrendPoint[];
  tool_call_count?: number;
  mcp_calls?: HistoryToolCount[];
  skill_calls?: HistoryToolCount[];
  builtin_calls?: HistoryToolCount[];
}

export interface HistorySessionDetail extends HistorySessionSummary {
  usage?: HistorySessionUsage;
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

export interface HistorySessionView extends HistorySessionSummary {
  sessionKey: string;
  alias: string;
  starred: boolean;
  tags: string[];
  displayTitle: string;
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
