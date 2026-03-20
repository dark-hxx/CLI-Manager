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
}

export interface CommandTemplate {
  id: string;
  project_id: string | null;
  name: string;
  command: string;
  description: string;
  sort_order: number;
}

export interface CreateTemplateInput {
  project_id?: string | null;
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
}

export interface HistorySessionDetail extends HistorySessionSummary {
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

export const SHELL_OPTIONS = [
  { value: "powershell", label: "PowerShell" },
  { value: "cmd", label: "CMD" },
  { value: "pwsh", label: "PowerShell Core" },
  { value: "wsl", label: "WSL" },
  { value: "bash", label: "Bash" },
] as const;
