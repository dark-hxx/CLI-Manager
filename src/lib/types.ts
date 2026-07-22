import type { HistorySourceId } from "./historySources";

export interface Group {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
}

export type WorktreeIsolationStrategy = "prompt" | "disabled" | "autoParallel" | "always";

export type ProjectEnvironmentType = "local" | "wsl" | "ssh";
export type SshConnectionState = "connecting" | "authenticating" | "connected" | "disconnected" | "failed";
export type SshDisconnectReason = "remote_exit" | "remote_command_exit" | "ssh_transport_error" | "local_process_error";

export type SshAuthMode =
  | "ssh_config"
  | "agent"
  | "identity_file"
  | "password_prompt"
  | "interactive"
  | "credential_ref";

export type SshJumpMode = "none" | "host" | "proxy_jump";

export type SshProxyType = "none" | "http" | "socks5" | "proxy_command";
export type SshToolSource = "claude" | "codex";
export type SshToolIntegrationScopeKind = "hostPrimary" | "projectOverride" | "retainedRoot";
export type SshToolIntegrationValidationState =
  | "unvalidated"
  | "validating"
  | "valid"
  | "invalid"
  | "unbound";
export type SshToolIntegrationCleanupState = "active" | "orphaned" | "cleanupAvailable" | "retained";

export interface SshHostGroup {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
}

export interface SshHost {
  id: string;
  name: string;
  group_name: string;
  group_id: string | null;
  host: string;
  port: number;
  username: string;
  config_alias: string;
  config_file: string;
  auth_mode: SshAuthMode;
  identity_file: string;
  credential_ref: string;
  jump_mode: SshJumpMode;
  jump_host_id: string | null;
  proxy_type: SshProxyType;
  proxy_host: string;
  proxy_port: number;
  proxy_command: string;
  connect_timeout_sec: number;
  server_alive_interval_sec: number;
  server_alive_count_max: number;
  terminal_encoding: string;
  startup_script: string;
  notes: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CreateSshHostInput {
  name: string;
  group_name?: string;
  group_id?: string | null;
  host?: string;
  port?: number;
  username?: string;
  config_alias?: string;
  config_file?: string;
  auth_mode?: SshAuthMode;
  identity_file?: string;
  credential_ref?: string;
  jump_mode?: SshJumpMode;
  jump_host_id?: string | null;
  proxy_type?: SshProxyType;
  proxy_host?: string;
  proxy_port?: number;
  proxy_command?: string;
  connect_timeout_sec?: number;
  server_alive_interval_sec?: number;
  server_alive_count_max?: number;
  terminal_encoding?: string;
  startup_script?: string;
  notes?: string;
}

export type UpdateSshHostInput = Partial<CreateSshHostInput> & { sort_order?: number };

export interface SshAgentInstallation {
  host_id: string;
  installation_id: string;
  remote_machine_id: string;
  agent_version: string;
  protocol_version: string;
  target: string;
  install_path: string;
  install_root: string;
  source: string;
  manifest_url: string;
  artifact_sha256: string;
  previous_version: string;
  status: string;
  checked_at: string;
}

export interface SshAgentInstallPreview {
  action: "install" | "upgrade" | "reinstall" | "downgrade";
  manifestUrl: string;
  channel: string;
  version: string;
  protocolMin: number;
  protocolMax: number;
  target: string;
  artifactUrl: string;
  artifactSize: number;
  artifactSha256: string;
  installRoot: string;
  installPath: string;
  currentVersion: string;
  distributionSource: "bundled" | "remote";
}

export interface SshAgentOperationResult {
  action: "installed" | "updated" | "rolledBack" | "uninstalled" | "purged";
  installationId: string;
  remoteMachineId: string;
  agentVersion: string;
  protocolVersion: string;
  target: string;
  installRoot: string;
  installPath: string;
  source: string;
  manifestUrl: string;
  artifactSha256: string;
  previousVersion: string;
}

export interface SshAgentProbeResult {
  status: "installed" | "notInstalled" | "incompatible" | "corrupt" | "unreachable" | "unsupported" | "authenticationRequired";
  code: string;
  installationId: string;
  remoteMachineId: string;
  installPath: string;
  agentVersion: string;
  protocolVersion: string;
  target: string;
  supported: boolean;
  detail: string;
}

export type SshRemoteHookStatus = "notInstalled" | "partialInstalled" | "outdated" | "installed" | "conflict";

export interface SshRemoteHookExpectedFile {
  role: string;
  canonicalPath: string;
  fingerprint: string;
}

export interface SshRemoteHookConfigFile extends SshRemoteHookExpectedFile {
  exists: boolean;
}

export interface SshRemoteHookConfigChange {
  role: string;
  canonicalPath: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  action: "unchanged" | "create" | "update" | "delete";
}

export interface SshRemoteHookInstallationFile {
  role: string;
  canonicalPath: string;
  beforeFingerprint: string;
  afterFingerprint: string;
}

export interface SshRemoteHookInstallationRecord {
  source: SshToolSource;
  installationId: string;
  ownerId: string;
  configuredConfigRoot: string;
  canonicalConfigRoot: string;
  configFiles: SshRemoteHookInstallationFile[];
  managedEntries: number;
  adapterVersion: number;
  installedAt: number;
  historySourceCandidate: {
    source: SshToolSource;
    canonicalConfigRoot: string;
    configRootHash: string;
  };
}

export interface SshRemoteHookConfigReport {
  action: "inspect" | "previewInstall" | "previewUninstall" | "installed" | "uninstalled";
  status: SshRemoteHookStatus;
  source: SshToolSource;
  installationId: string;
  remoteMachineId: string;
  configuredConfigRoot: string;
  canonicalConfigRoot: string;
  configRootHash: string;
  configRootExists: boolean;
  willCreateConfigRoot: boolean;
  configFiles: SshRemoteHookConfigFile[];
  managedEntries: number;
  requiredEntries: number;
  changes: SshRemoteHookConfigChange[];
  installation: SshRemoteHookInstallationRecord | null;
}

export interface SshHostToolPreference {
  host_id: string;
  source: SshToolSource;
  configured_root: string;
  updated_at: string;
}

export interface SshAgentToolIntegration {
  integration_id: string;
  host_id: string | null;
  installation_id: string;
  remote_machine_id: string;
  ssh_user: string;
  source: SshToolSource;
  scope_kind: SshToolIntegrationScopeKind;
  configured_root: string;
  canonical_root: string;
  config_root_hash: string;
  hook_record_json: string;
  history_source_instance_id: string;
  validation_state: SshToolIntegrationValidationState;
  cleanup_state: SshToolIntegrationCleanupState;
  checked_at: string;
}

export interface SshConfigImportHost {
  alias: string;
  sourceFile: string;
}

export interface SshConfigImportWarning {
  code: string;
  sourceFile: string;
}

export interface SshConfigImportPreview {
  configDir: string;
  configFile: string;
  isDefault: boolean;
  hosts: SshConfigImportHost[];
  warnings: SshConfigImportWarning[];
}

export type WorktreeStatus = "active" | "missing";

export interface WorktreeRecord {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  path: string;
  base_branch: string;
  deps_prompt_dismissed: number;
  provider_overrides: string;
  status: WorktreeStatus;
  created_at: string;
  updated_at: string;
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
  worktree_strategy: WorktreeIsolationStrategy;
  worktree_root: string;
  worktree_deps_prompt_enabled: number;
  environment_type: ProjectEnvironmentType;
  ssh_host_id: string | null;
  remote_path: string;
  cli_config_root: string;
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
  worktree_strategy?: WorktreeIsolationStrategy;
  worktree_root?: string;
  worktree_deps_prompt_enabled?: number;
  environment_type?: ProjectEnvironmentType;
  ssh_host_id?: string | null;
  remote_path?: string;
  cli_config_root?: string;
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
  worktree_strategy?: WorktreeIsolationStrategy;
  worktree_root?: string;
  worktree_deps_prompt_enabled?: number;
  environment_type?: ProjectEnvironmentType;
  ssh_host_id?: string | null;
  remote_path?: string;
  cli_config_root?: string;
}

export type TerminalScope =
  | { kind: "all" }
  | { kind: "project"; projectId: string }
  | { kind: "group"; groupId: string }
  | { kind: "worktree"; projectId: string; worktreeId: string };

export interface CreateGroupInput {
  name: string;
  parent_id?: string | null;
}

export type TreeNode =
  | { type: "group"; group: Group; children: TreeNode[] }
  | { type: "project"; project: Project; worktrees?: WorktreeRecord[] }
  | { type: "worktree"; project: Project; worktree: WorktreeRecord };

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

export type RemoteHandoffPhase = "pending" | "active" | "cancelling" | "recovery_failed";

export interface RemoteHandoffSessionState {
  phase: RemoteHandoffPhase;
  cliSessionId: string;
  projectName: string;
  workDir: string;
  providerId?: string;
  providerName?: string;
  platform?: "telegram" | "feishu" | "weixin" | "wecom";
  startedAtMs?: number;
}

export interface TerminalSession {
  id: string;
  projectId?: string;
  worktreeId?: string;
  title: string;
  // 重建 PTY 必需参数
  cwd?: string;
  shell?: string | null;
  envVars?: Record<string, string>;
  startupCmd?: string;
  environmentType?: ProjectEnvironmentType;
  sshHostId?: string;
  remotePath?: string;
  connectionState?: SshConnectionState;
  disconnectReason?: SshDisconnectReason;
  /** 终端首次挂载时写入 xterm scrollback 的本地文本，不发送到 PTY。 */
  initialTerminalOutput?: string;
  /** true 时启动命令由 XTermTerminal 在 initialTerminalOutput 写完后再发送。 */
  deferStartupUntilInitialOutput?: boolean;
  cliSessionId?: string;
  remoteTranscriptRef?: string;
  remoteHistoryConsumerId?: string;
  remoteHistorySourceInstanceId?: string;
  /** 远程托管期间保留标签元数据，但本地不再持有 PTY。 */
  remoteHandoff?: RemoteHandoffSessionState;
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
  isSymlink?: boolean;
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

export type HistorySource = HistorySourceId;
export type HistorySourceFilter = "all" | HistorySourceId;
export type CcusageSource = "all" | "claude" | "codex";

export interface HistoryRawPointer {
  role: string;
  kind: string;
  rawKey: string;
  lineIndex?: number | null;
}

export interface HistorySessionRef {
  sourceId: HistorySource;
  sourceInstanceId: string;
  sourceSessionId: string;
  transportKind: "local" | "wsl" | "ssh" | string;
  rawPointers: HistoryRawPointer[];
}

export interface HistoryRemoteIdentity {
  hostId?: string;
  installationId?: string;
  remoteMachineId?: string;
  sshUser?: string;
  configRootHash?: string;
}

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
  session_ref?: HistorySessionRef | null;
  materialization_level?: "summary" | "detail" | "full" | string;
  freshness_state?: "fresh" | "partial" | "stale" | "offline" | string;
  as_of?: number | null;
  remote_identity?: HistoryRemoteIdentity | null;
  read_only?: boolean;
  usage?: HistorySessionUsage;
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
  /** 源 JSONL 文件物理行号（0-based）；子任务聚合消息/旧快照为 null，不可编辑。 */
  line_index?: number | null;
  /** 该行存在规范文本块（Claude text / Codex input_text|output_text）时才允许编辑与删除。 */
  editable?: boolean;
  /** 编辑预填与写回守卫用的规范文本；与展示 content 一致时后端省略（用 content 兜底）。 */
  editable_text?: string | null;
}

/** 会话历史消息编辑审计记录（history_edit_audit 表行）。 */
export interface HistoryEditAuditEntry {
  id: number;
  session_key: string;
  session_id: string;
  source: string;
  file_path: string;
  op: "edit" | "delete" | "insert" | "restore" | string;
  line_index: number | null;
  role: string | null;
  before_text: string | null;
  after_text: string | null;
  backup_path: string | null;
  created_at: number;
}

export interface HistoryBackupStatus {
  hasBackup: boolean;
  backupPath: string | null;
  backupAt: number | null;
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
  session_ref?: HistorySessionRef | null;
  read_only?: boolean;
}

export interface SshRemoteHistorySyncResult {
  sourceInstanceId: string;
  source: SshToolSource;
  installationId: string;
  remoteMachineId: string;
  sshUser: string;
  configuredConfigRoot: string;
  canonicalConfigRoot: string;
  configRootHash: string;
  generation: number;
  cursor: string;
  hasMore: boolean;
  totalSessions: number;
  freshnessState: string;
  asOf: number;
  discoveryComplete: boolean;
  partial: boolean;
  sessions: unknown[];
  tombstones: string[];
  warnings: string[];
}

export interface SshRemoteResumePreflight {
  source: SshToolSource;
  sourceSessionId: string;
  sourceInstanceId: string;
  installationId: string;
  remoteMachineId: string;
  sshUser: string;
  canonicalConfigRoot: string;
  remoteCwd: string;
  cliCommand: string;
  resumeArgs: string[];
  resumeCommand: string;
  environmentOverrides: Record<string, string>;
  parserVersion: number;
  indexedAt: number;
}

export type HistoryIndexPhase = "idle" | "seeding" | "scanning" | "indexing" | "ready" | "error";

export interface HistoryIndexStatus {
  rootsKey: string;
  phase: HistoryIndexPhase;
  indexedFiles: number;
  totalFiles: number;
  generation: number;
  partial: boolean;
  lastCompletedAt: number | null;
  error: string | null;
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

export interface RequestLogFilters {
  source?: "claude" | "codex" | null;
  project_key?: string | null;
  model?: string | null;
  session_query?: string | null;
  start_at?: number | null;
  end_at?: number | null;
}

export interface RequestLogSyncResult {
  scanned_files: number;
  changed_files: number;
  removed_files: number;
  written_rows: number;
  failed_files: number;
  synced_at_ms: number;
}

export interface RequestLogItem {
  request_id: string;
  source: "claude" | "codex";
  project_key: string;
  session_id: string;
  file_path: string;
  event_index: number;
  timestamp_ms: number;
  model?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  unpriced_tokens: number;
  status: "recorded";
  session_available: boolean;
}

export interface RequestLogSummary {
  total: number;
  total_tokens: number;
  total_cost_usd: number;
  unpriced_tokens: number;
}

export interface RequestLogPage {
  data: RequestLogItem[];
  summary: RequestLogSummary;
  total: number;
  page: number;
  page_size: number;
}

export const SHELL_OPTIONS_WINDOWS = [
  { value: "powershell", label: "PowerShell" },
  { value: "cmd", label: "CMD" },
  { value: "pwsh", label: "PowerShell 7" },
  { value: "wsl", label: "WSL" },
  { value: "gitbash", label: "Git Bash" },
  { value: "bash", label: "Bash" },
] as const;

export const SHELL_OPTIONS_MACOS = [
  { value: "zsh", label: "Zsh" },
  { value: "bash", label: "Bash" },
  { value: "fish", label: "Fish" },
  { value: "sh", label: "Sh" },
  { value: "pwsh", label: "PowerShell 7" },
] as const;

export const SHELL_OPTIONS_LINUX = [
  { value: "bash", label: "Bash" },
  { value: "zsh", label: "Zsh" },
  { value: "fish", label: "Fish" },
  { value: "sh", label: "Sh" },
  { value: "pwsh", label: "PowerShell 7" },
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

export interface GitBranchInfo {
  name: string;
  branchType: "local" | "remote";
  current: boolean;
  upstream: string | null;
  remote: string | null;
}
