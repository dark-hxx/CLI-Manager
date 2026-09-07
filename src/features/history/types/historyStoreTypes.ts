import { type SshAgentHistoryContext } from "../../../lib/sshAgentHistory";
import type {
  HistoryBackupStatus,
  HistoryGeneratedTitleMeta,
  HistoryGeneratedTitleTrigger,
  HistoryEditAuditEntry,
  HistoryIndexStatus,
  HistoryMessage,
  HistoryPromptItem,
  HistorySearchHit,
  HistorySessionDetail,
  HistorySessionView,
  HistoryStatsPayload,
  PromptScope,
  HistorySourceFilter,
  SessionMeta,
} from "../../../lib/types";

export type SessionMetaMap = Record<string, SessionMeta>;

export type GeneratedTitleMap = Record<string, HistoryGeneratedTitleMeta>;

export interface MetaPatchInput {
  alias?: string;
  starred?: boolean;
  tags?: string[];
}

export interface OpenHistoryOptions {
  sourceFilter?: HistorySourceFilter;
  projectPath?: string | null;
  /** 左侧/入口选中的具体项目 id；仅用于 UI 高亮，会话过滤仍按 path。 */
  projectId?: string | null;
  scopedProjectPath?: string | null;
}

export interface OpenSessionOptions {
  requireLiveDetail?: boolean;
}

export interface HistoryStore {
  isOpen: boolean;
  loadingSessions: boolean;
  loadingMoreSessions: boolean;
  loadingSessionDetail: boolean;
  searching: boolean;
  loadingPrompts: boolean;
  loadingStats: boolean;
  loadingStatsProjectOptions: boolean;
  statsError: string | null;
  statsProjectOptionsError: string | null;
  statsUpdatedAt: number | null;
  statsCacheKey: string | null;
  sourceFilter: HistorySourceFilter;
  projectPathFilter: string | null;
  /** 项目树高亮用；null 时回退到 path 匹配。 */
  projectIdFilter: string | null;
  scopedProjectPathFilter: string | null;
  sessions: HistorySessionView[];
  hasMoreSessions: boolean;
  sessionListOffset: number;
  sessionsIndexGeneration: number;
  activeSessionKey: string | null;
  activeSession: HistorySessionDetail | null;
  globalQuery: string;
  sessionQuery: string;
  searchHits: HistorySearchHit[];
  prompts: HistoryPromptItem[];
  stats: HistoryStatsPayload | null;
  statsProjectOptions: string[];
  focusedMessageIndex: number | null;
  focusedMessageSeq: number;
  metaMap: SessionMetaMap;
  generatedTitleMap: GeneratedTitleMap;
  /** 当前 WebView 已发起、尚未收到最终标题结果的会话；不持久化。 */
  smartTitleInFlightSessionKeys: Set<string>;
  focusGlobalSearchSeq: number;
  focusSessionSearchSeq: number;
  indexStatus: HistoryIndexStatus;
  remoteContext: SshAgentHistoryContext | null;
  ensureMetaTable: () => Promise<void>;
  openHistory: (options?: OpenHistoryOptions) => Promise<void>;
  closeHistory: (options?: { preserveRemoteConsumer?: boolean }) => void;
  toggleHistory: () => Promise<void>;
  setSourceFilter: (filter: HistorySourceFilter) => Promise<void>;
  setProjectPathFilter: (projectPath: string | null, projectId?: string | null) => Promise<void>;
  loadSessions: (options?: { background?: boolean }) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  loadIndexStatus: () => Promise<void>;
  refreshIndex: () => Promise<void>;
  addConvertedSession: (summary: unknown, detail: unknown) => string;
  openSession: (sessionKey: string, options?: OpenSessionOptions) => Promise<void>;
  openSearchHit: (hit: HistorySearchHit) => Promise<void>;
  deleteSession: (sessionKey: string) => Promise<void>;
  setGlobalQuery: (query: string) => void;
  runGlobalSearch: (query: string) => Promise<void>;
  setSessionQuery: (query: string) => void;
  loadPrompts: (options: {
    scope: PromptScope;
    query?: string;
    projectKey?: string | null;
    sessionKey?: string | null;
    limit?: number;
  }) => Promise<void>;
  loadStatsProjectOptions: (options?: { force?: boolean }) => Promise<string[]>;
  loadStats: (options?: {
    projectKey?: string | null;
    projectPath?: string | null;
    rangeDays?: number;
    startAt?: number | null;
    endAt?: number | null;
    force?: boolean;
  }) => Promise<void>;
  openSessionAtMessage: (sessionKey: string, messageIndex: number) => Promise<void>;
  clearFocusedMessage: () => void;
  updateMeta: (sessionKey: string, patch: MetaPatchInput) => Promise<void>;
  cancelAutomaticSmartTitles: () => void;
  generateSmartTitle: (sessionKey: string, triggerKind?: HistoryGeneratedTitleTrigger) => Promise<void>;
  clearSmartTitle: (sessionKey: string) => Promise<void>;
  updateMessage: (sessionKey: string, message: HistoryMessage, newText: string) => Promise<void>;
  deleteMessage: (sessionKey: string, message: HistoryMessage) => Promise<void>;
  deleteMessages: (sessionKey: string, messages: HistoryMessage[]) => Promise<void>;
  insertMessage: (
    sessionKey: string,
    afterMessage: HistoryMessage,
    role: "user" | "assistant",
    text: string
  ) => Promise<void>;
  /** 审计撤回"删除"用：按原行号提示就近恢复一条消息（行号漂移由后端锚点扫描兜底）。 */
  reinsertMessage: (sessionKey: string, lineIndexHint: number, role: string, text: string) => Promise<void>;
  restoreSessionBackup: (sessionKey: string) => Promise<void>;
  fetchBackupStatus: (sessionKey: string) => Promise<HistoryBackupStatus>;
  listEditAudit: (sessionKey: string, limit?: number) => Promise<HistoryEditAuditEntry[]>;
  triggerGlobalSearchFocus: () => void;
  triggerSessionSearchFocus: () => void;
}

export interface StatsCacheEntry {
  payload: HistoryStatsPayload;
  cachedAt: number;
}

export interface StatsProjectOptionsCacheEntry {
  options: string[];
  cachedAt: number;
}

export interface TodayProjectStats {
  sessions: number;
  totalTokens: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  unpricedTokens: number;
  routeRecords?: number;
  sessionFallbackRecords?: number;
  unattributedRecords?: number;
  missingUsageRecords?: number;
}

export interface FetchHistoryStatsOptions {
  sourceFilter: HistorySourceFilter;
  projectKey?: string | null;
  projectPath?: string | null;
  sourceInstanceId?: string | null;
  rangeDays?: number | null;
  startAt?: number | null;
  endAt?: number | null;
  force?: boolean;
}

export interface FetchHistoryRequestLogStatsOptions {
  sourceFilter: HistorySourceFilter;
  projectKey?: string | null;
  projectPath?: string | null;
  model?: string | null;
  startAt?: number | null;
  endAt?: number | null;
  force?: boolean;
}

export type HistoryEditOp = "edit" | "delete" | "insert" | "restore";

export interface HistoryEditOutcome {
  detail: HistorySessionDetail;
  beforeText: string | null;
  afterText: string | null;
  backupPath: string | null;
}

export interface HistoryBatchDeleteOutcome {
  detail: HistorySessionDetail;
  backupPath: string | null;
  removed: Array<{ lineIndex: number | null; role: string; text: string }>;
}

export interface RemoteHistorySyncOptions {
  reset?: boolean;
  limit?: number;
  forceRefresh?: boolean;
}
