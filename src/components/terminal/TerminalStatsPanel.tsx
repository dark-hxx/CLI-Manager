import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Copy, FolderGit2, GitBranch, RefreshCw, FolderOpen, Save } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { createPatch } from "diff";
import type { HistoryFileChangeSummary, HistorySessionDetail, HistorySource, WorktreeRecord } from "../../lib/types";
import {
  fetchLatestProjectSessionDetail,
  fetchTodayProjectStatsMerged,
  type TodayProjectStats,
} from "../../stores/historyStore";
import { useProjectStore } from "../../stores/projectStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useSettingsStore, type TerminalStatsCardKey } from "../../stores/settingsStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import {
  TERM,
  StatCard,
  SourcePill,
  Row,
  StatChip,
  SegmentedBar,
  LiveDot,
  EmptyHint,
  calculateTokenStats,
  formatDuration,
  formatRelativeTime,
  truncatePath,
} from "../stats/termStatsUi";
import {
  TokenUsageCard,
  ModelContextCard,
  TrendCard,
  ToolsCard,
  TodayUsageCard,
  LatestChangesCard,
  type LatestChangesCardData,
} from "../stats/termStatsCards";
import { useI18n } from "../../lib/i18n";
import { useSaveSessionToSidebar } from "../../hooks/useSaveSessionToSidebar";
import { DiffViewerModal } from "../git/DiffViewerModal";
import { parseDiffBlocksFromMessages } from "../../lib/diffParser";
import { resolveTerminalProjectPath } from "../../lib/terminalOscPath";
import {
  resolveTodayProjectStatsScope,
  resolveTodayUsageProjectPaths,
} from "../../lib/historyProjectPaths";
import { TerminalSquare } from "../icons";

interface TerminalStatsPanelProps {
  activeSessionId: string | null;
  open: boolean;
  visible?: boolean;
  embedded?: boolean;
}

const POLL_INTERVAL_MS = 10_000;
const TICK_INTERVAL_MS = 30_000;
const TERMINAL_PANEL_SCROLLBAR_STYLE = {
  "--ui-scrollbar-thumb": TERM.border,
  "--ui-scrollbar-track": TERM.bg,
} as CSSProperties;

// 按作用域（含 tabId）缓存已解析的会话详情：切回已看过的 Tab 先显缓存再后台刷新，
// 避免重复解析 jsonl 时的「加载中」闪烁。终端数量有限，不做淘汰。
const sessionDetailCache = new Map<string, HistorySessionDetail>();

const ROLE_COLORS: Record<string, string> = {
  user: TERM.green,
  assistant: TERM.blue,
  tool: TERM.yellow,
};

// 未绑定 hook 会话时喂给 4 张会话级卡片的空数据（全 0 Token、无模型），复用同一引用
const EMPTY_TOKEN_STATS = calculateTokenStats(null);

// 来源徽章配色：claude 黄 / codex 青，与终端 Tab 的 CLI 区分一致
// 从终端会话的启动命令/标题推断该终端运行的 CLI（项目设置中配置的 cli_tool 会进入两者）
function inferHistorySource(haystack: string): HistorySource | null {
  const lower = haystack.toLowerCase();
  if (/\bcodex\b/.test(lower)) return "codex";
  if (/\bclaude\b/.test(lower)) return "claude";
  return null;
}

function formatStatsShellLabel(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "默认 Shell";
  const normalized = trimmed.toLowerCase();
  if (normalized === "powershell" || normalized === "powershell.exe") return "PowerShell";
  if (normalized === "pwsh" || normalized === "pwsh.exe") return "PowerShell 7";
  if (normalized === "cmd") return "CMD";
  if (normalized === "wsl") return "WSL";
  if (normalized === "gitbash" || normalized === "git-bash" || normalized === "git bash") return "Git Bash";
  if (normalized === "bash") return "Bash";
  if (normalized === "zsh") return "Zsh";
  if (normalized === "fish") return "Fish";
  if (normalized === "sh") return "sh";
  return trimmed;
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function buildFallbackFileChanges(session: HistorySessionDetail | null): HistoryFileChangeSummary[] {
  if (!session) return [];
  const groups = new Map<string, HistoryFileChangeSummary>();
  for (const block of parseDiffBlocksFromMessages(session.messages)) {
    const changes = countPatchLines(block.patch);
    const operation = {
      source: "patch",
      tool_name: null,
      file_path: block.filePath,
      old_text: null,
      new_text: null,
      patch: block.patch,
      additions: changes.additions,
      deletions: changes.deletions,
      message_index: block.messageIndex,
      operation_group_index: block.messageIndex,
      timestamp: block.timestamp,
    };
    const current = groups.get(block.filePath) ?? {
      file_path: block.filePath,
      status: "M",
      additions: 0,
      deletions: 0,
      latest_message_index: block.messageIndex,
      latest_operation_group_index: block.messageIndex,
      latest_timestamp: block.timestamp,
      operations: [],
    };
    current.additions += changes.additions;
    current.deletions += changes.deletions;
    if ((block.messageIndex ?? -1) >= (current.latest_message_index ?? -1)) {
      current.latest_message_index = block.messageIndex;
      current.latest_operation_group_index = block.messageIndex;
      current.latest_timestamp = block.timestamp;
    }
    current.operations.push(operation);
    groups.set(block.filePath, current);
  }
  return Array.from(groups.values());
}

function selectLatestFileChanges(fileChanges: HistoryFileChangeSummary[]): HistoryFileChangeSummary[] {
  return fileChanges.flatMap((item) => {
    if (item.file_path.trim().toLowerCase() === "unknown-file") return [];

    const latestGroupIndex = item.latest_operation_group_index ?? -1;
    const latestMessageIndex = item.latest_message_index ?? -1;
    const operations = item.operations.filter((operation) => {
      if (latestGroupIndex >= 0) {
        return (operation.operation_group_index ?? -1) === latestGroupIndex;
      }
      if (latestMessageIndex >= 0) {
        return (operation.message_index ?? -1) === latestMessageIndex;
      }
      return true;
    });
    if (operations.length === 0) return [];

    const latestOperation = operations[operations.length - 1];
    return [{
      ...item,
      additions: operations.reduce((sum, operation) => sum + operation.additions, 0),
      deletions: operations.reduce((sum, operation) => sum + operation.deletions, 0),
      latest_message_index: latestOperation.message_index ?? item.latest_message_index ?? null,
      latest_operation_group_index: latestOperation.operation_group_index ?? item.latest_operation_group_index ?? null,
      latest_timestamp: latestOperation.timestamp ?? item.latest_timestamp ?? null,
      operations,
    }];
  }).sort((left, right) => {
    const groupDiff = (right.latest_operation_group_index ?? -1) - (left.latest_operation_group_index ?? -1);
    if (groupDiff !== 0) return groupDiff;
    const messageDiff = (right.latest_message_index ?? -1) - (left.latest_message_index ?? -1);
    if (messageDiff !== 0) return messageDiff;
    return (right.latest_timestamp ?? "").localeCompare(left.latest_timestamp ?? "");
  }).slice(0, 3);
}

function buildLatestChangesSummary(session: HistorySessionDetail | null): LatestChangesCardData | null {
  if (!session) return null;
  const fileChanges = session.file_changes?.length ? session.file_changes : buildFallbackFileChanges(session);
  const latestFiles = selectLatestFileChanges(fileChanges);
  if (latestFiles.length === 0) return null;
  return {
    fileCount: latestFiles.length,
    additions: latestFiles.reduce((sum, item) => sum + item.additions, 0),
    deletions: latestFiles.reduce((sum, item) => sum + item.deletions, 0),
    files: latestFiles,
  };
}

function buildLatestChangeDiffText(fileChange: HistoryFileChangeSummary): string {
  return fileChange.operations
    .map((operation) =>
      operation.patch ||
      createPatch(fileChange.file_path, operation.old_text ?? "", operation.new_text ?? "", "", "")
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * A6+A7: 统一定时器调度 - 实时查询项目当前 git 分支
 * 初始值为会话静态分支，避免首屏闪烁；轮询由外部统一调度
 */
function useCurrentGitBranch(
  projectPath: string | null,
  enabled: boolean,
  initialBranch: string | null,
  pollTrigger: number
): string | null {
  const [branch, setBranch] = useState<string | null>(initialBranch);
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !projectPath) {
      setBranch(initialBranch);
      lastPathRef.current = null;
      return;
    }

    // 路径变化时立即重置为初始分支，避免显示上一个项目的分支
    if (lastPathRef.current !== projectPath) {
      lastPathRef.current = projectPath;
      setBranch(initialBranch);
    }

    let cancelled = false;

    const fetchBranch = async () => {
      try {
        const result = await invoke<string | null>("get_current_git_branch", { path: projectPath });
        if (!cancelled) {
          setBranch(result);
        }
      } catch (error) {
        if (!cancelled) {
          setBranch(initialBranch);
        }
      }
    };

    void fetchBranch();

    return () => {
      cancelled = true;
    };
  }, [projectPath, enabled, initialBranch, pollTrigger]);

  return branch;
}

function SessionInfoCard({ session, statsSession, projectName, projectPath, currentBranch, shell, sessionId, worktree, onSaveToSidebar, canSaveToSidebar }: {
  session: HistorySessionDetail;
  statsSession: HistorySessionDetail | null;
  projectName: string;
  projectPath: string;
  currentBranch: string | null;
  shell: string;
  sessionId: string;
  worktree: WorktreeRecord | null;
  onSaveToSidebar?: () => void;
  canSaveToSidebar?: boolean;
}) {
  const { t } = useI18n();
  // 统计数据（消息/时长/角色分布）只认 hook 绑定的会话，未绑定时置空；
  // 元信息（项目/路径/分支/来源）来自当前终端，始终用 session 展示
  const roleCounts = useMemo(() => {
    const counts: Record<string, number> = { user: 0, assistant: 0, tool: 0 };
    for (const msg of statsSession?.messages ?? []) {
      const key = msg.role in counts ? msg.role : "tool";
      counts[key] += 1;
    }
    return counts;
  }, [statsSession]);

  const duration = statsSession
    ? formatDuration(statsSession.updated_at - statsSession.created_at)
    : "—";
  const messageCount = statsSession?.messages.length ?? 0;
  // 实时统计面板优先显示当前实时分支，回退到会话记录的静态分支
  const branch = currentBranch ?? session.branch ?? "—";
  const sessionIdTitle = `${sessionId}\n\n${t("termStats.copySessionIdHint")}`;

  // 双击打开项目文件夹
  const handleOpenFolder = useCallback(() => {
    void invoke("open_folder_in_explorer", { path: projectPath }).catch((err) => {
      console.error("Failed to open folder:", err);
    });
  }, [projectPath]);

  const handleCopySessionId = useCallback(() => {
    void navigator.clipboard
      .writeText(sessionId)
      .then(() => toast.success(t("termStats.copySessionIdSuccess")))
      .catch((err) => toast.error(t("termStats.copySessionIdFailed"), { description: String(err) }));
  }, [sessionId, t]);

  return (
    <StatCard
      icon={<FolderGit2 size={13} />}
      iconColor={TERM.cyan}
      title={t("termStats.session")}
      headerRight={
        <SourcePill source={session.source} />
      }
    >
      <Row icon={<FolderGit2 size={10} />} label={t("termStats.project")} value={projectName} title={projectName} />
      <Row
        icon={<FolderOpen size={10} />}
        label={t("termStats.path")}
        value={truncatePath(projectPath, 3)}
        color={TERM.dim}
        title={`${projectPath}\n\n${t("termStats.openFolderHint")}`}
        onDoubleClick={handleOpenFolder}
      />
      {worktree && (
        <Row
          icon={<GitBranch size={10} />}
          label={t("worktree.settings.title")}
          value={worktree.name}
          color={TERM.magenta}
          title={`${worktree.branch}\n${worktree.path}`}
        />
      )}
      <Row icon={<TerminalSquare size={10} strokeWidth={1.7} />} label={t("termStats.shell")} value={shell} color={TERM.cyan} title={shell} />
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-5">
        <span className="flex shrink-0 items-center gap-1" style={{ color: TERM.dim }}>
          <Copy size={10} />
          {t("termStats.sessionId")}
        </span>
        <span className="flex min-w-0 items-center gap-1">
          <span
            className="truncate text-right cursor-pointer hover:underline"
            style={{ color: TERM.fg }}
            title={sessionIdTitle}
            onDoubleClick={handleCopySessionId}
          >
            {sessionId}
          </span>
          {onSaveToSidebar && (
            <button
              type="button"
              onClick={onSaveToSidebar}
              disabled={!canSaveToSidebar}
              className="ui-focus-ring shrink-0 rounded p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: TERM.cyan }}
              title={t("terminal.tab.saveToSidebar")}
              aria-label={t("terminal.tab.saveToSidebar")}
            >
              <Save size={11} />
            </button>
          )}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-5">
        <span className="flex shrink-0 items-center gap-1" style={{ color: TERM.dim }}>
          <GitBranch size={10} />
          {t("termStats.branch")}
        </span>
        <span className="truncate text-right" style={{ color: TERM.magenta }} title={branch}>
          {branch}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <StatChip dotColor={TERM.cyan} label={t("termStats.messageCount")} value={String(messageCount)} />
        <StatChip dotColor={TERM.green} label={t("termStats.duration")} value={duration} />
      </div>

      <div className="mt-2">
        <SegmentedBar
          parts={[
            { value: roleCounts.user, color: ROLE_COLORS.user, label: t("termStats.user") },
            { value: roleCounts.assistant, color: ROLE_COLORS.assistant, label: t("termStats.assistant") },
            { value: roleCounts.tool, color: ROLE_COLORS.tool, label: t("termStats.tool") },
          ]}
        />
        <div className="mt-1 flex gap-3 text-[10px]" style={{ color: TERM.dim }}>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ROLE_COLORS.user }} />
            {t("termStats.user")} {roleCounts.user}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ROLE_COLORS.assistant }} />
            {t("termStats.assistant")} {roleCounts.assistant}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ROLE_COLORS.tool }} />
            {t("termStats.tool")} {roleCounts.tool}
          </span>
        </div>
      </div>
    </StatCard>
  );
}

export function TerminalStatsPanel({ activeSessionId, open, visible = true, embedded = false }: TerminalStatsPanelProps) {
  const { t } = useI18n();
  const { canSave, saveSession, saveSessionDialog } = useSaveSessionToSidebar();
  const terminalStatsCardVisibility = useSettingsStore((state) => state.terminalStatsCardVisibility);
  const terminalStatsCardOrder = useSettingsStore((state) => state.terminalStatsCardOrder);
  const terminalSessions = useTerminalStore((state) => state.sessions);
  const projects = useProjectStore((state) => state.projects);
  const worktrees = useWorktreeStore((state) => state.worktrees);

  const [latestSession, setLatestSession] = useState<HistorySessionDetail | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [todayStats, setTodayStats] = useState<TodayProjectStats | null>(null);
  const [loadingToday, setLoadingToday] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [pollTrigger, setPollTrigger] = useState(0); // A6: 统一轮询触发器
  const [diffFileChange, setDiffFileChange] = useState<HistoryFileChangeSummary | null>(null);
  const latestRef = useRef<HistorySessionDetail | null>(null);
  const lastPathRef = useRef<string | null>(null);
  const wasPanelActiveRef = useRef(false);

  const terminalSession = useMemo(
    () => terminalSessions.find((session) => session.id === activeSessionId) ?? null,
    [terminalSessions, activeSessionId]
  );

  const project = useMemo(
    () => projects.find((item) => item.id === terminalSession?.projectId) ?? null,
    [projects, terminalSession?.projectId]
  );

  // Worktree tabs must query history/Git by the isolated checkout path.
  const activeWorktree = terminalSession?.worktreeId
    ? worktrees.find((worktree) => worktree.id === terminalSession.worktreeId) ?? null
    : null;
  const terminalProjectPath = resolveTerminalProjectPath(
    terminalSession?.cwd,
    project?.path,
    "unknown"
  );
  const lookupProjectPath = activeWorktree?.path || terminalProjectPath;
  const displayProjectPath = activeWorktree?.path || terminalProjectPath;
  // Issue #137：今日项目用量按「主项目路径 + 该项目下全部 worktree」聚合，避免 worktree 被当成独立目录。
  const todayUsageProjectPaths = useMemo(() => {
    const worktreePaths: string[] = [];
    if (project?.id) {
      for (const worktree of worktrees) {
        if (worktree.project_id !== project.id) continue;
        if (worktree.status === "missing") continue;
        if (worktree.path?.trim()) worktreePaths.push(worktree.path.trim());
      }
    }
    return resolveTodayUsageProjectPaths(project?.path, lookupProjectPath, worktreePaths);
  }, [lookupProjectPath, project?.id, project?.path, worktrees]);

  // 终端运行的 CLI 工具（claude/codex），来自项目设置；推断不出则不过滤
  const sourceFilter = useMemo(
    () =>
      inferHistorySource(
        `${terminalSession?.startupCmd ?? ""} ${terminalSession?.title ?? ""} ${project?.cli_tool ?? ""}`
      ),
    [terminalSession?.startupCmd, terminalSession?.title, project?.cli_tool]
  );
  const todayUsageScope = useMemo(
    () => resolveTodayProjectStatsScope(
      todayUsageProjectPaths,
      [latestSession?.project_key]
    ),
    [latestSession?.project_key, todayUsageProjectPaths]
  );

  // 4 张「会话级」卡片（Token 用量/趋势/模型上下文/工具）只认 hook 绑定的 CLI 会话：
  // 仅当本终端已拿到 cliSessionId 且加载到的会话 session_id 与之一致时才展示，
  // 否则置空。其余卡片（会话信息/今日用量）按项目级回退正常展示，不受此门控影响。
  const tokensBound =
    Boolean(terminalSession?.cliSessionId) &&
    latestSession?.session_id === terminalSession?.cliSessionId;
  const panelActive = open && visible;

  // 首次打开侧栏时再触发一次刷新，避开面板激活与历史源初始化同帧完成导致的空态停留。
  useEffect(() => {
    if (!panelActive) {
      wasPanelActiveRef.current = false;
      return;
    }
    if (wasPanelActiveRef.current) return;
    wasPanelActiveRef.current = true;
    latestRef.current = null;
    setRefreshSeq((prev) => prev + 1);
  }, [panelActive]);

  // A6: 统一定时器调度 - 10s 主节拍同时触发会话数据轮询和 git 分支查询
  useEffect(() => {
    if (!panelActive) return;
    const timer = window.setInterval(() => {
      setPollTrigger((prev) => prev + 1);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [panelActive]);

  // 会话数据轮询：updated_at 未变化时跳过 jsonl 重解析
  // 多窗口隔离：scopeKey 含 activeSessionId(tabId)，不同终端窗口的数据各自独立缓存与查询
  useEffect(() => {
    if (!panelActive || !lookupProjectPath) {
      lastPathRef.current = null;
      latestRef.current = null;
      setLatestSession(null);
      return;
    }
    // 切换 Tab（项目路径、CLI 来源、Tab ID 或 cliSessionId 变化）时按作用域换数据：
    // 命中内存缓存则先秒显缓存，无缓存才清空；随后后台刷新校正。
    const scopeKey = `${activeSessionId}|${lookupProjectPath}|${sourceFilter ?? ""}|${terminalSession?.cliSessionId ?? ""}`;
    if (lastPathRef.current !== scopeKey) {
      lastPathRef.current = scopeKey;
      const cached = sessionDetailCache.get(scopeKey) ?? null;
      latestRef.current = cached;
      setLatestSession(cached);
      setUpdatedAt(cached ? Date.now() : null);
    }
    let cancelled = false;

    const loadSession = async (initial: boolean) => {
      if (initial && !latestRef.current) setLoadingSession(true);
      const current = latestRef.current;
      const prev = current
        ? { filePath: current.file_path, updatedAt: current.updated_at }
        : undefined;
      const result = await fetchLatestProjectSessionDetail(
        lookupProjectPath,
        prev,
        sourceFilter,
        terminalSession?.cliSessionId
      );
      if (cancelled) return;
      if (result !== "unchanged") {
        latestRef.current = result;
        setLatestSession(result);
        setUpdatedAt(Date.now());
        if (result) sessionDetailCache.set(scopeKey, result);
      }
      if (initial) {
        setLoadingSession(false);
        if (updatedAt === null) setUpdatedAt(Date.now());
      }
    };

    void loadSession(true);

    return () => {
      cancelled = true;
    };
    // activeSessionId 入依赖：切换 Tab 时立即重新核对最近会话（unchanged 时开销仅一次列表查询）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, displayProjectPath, lookupProjectPath, panelActive, pollTrigger, project?.path, refreshSeq, sourceFilter, terminalSession?.cliSessionId, terminalSession?.cwd, terminalSession?.projectId]);

  // 今日项目用量：会话数据变化时同步刷新（与终端 CLI 来源保持一致）
  // Issue #137：聚合主项目 + worktree 路径，主仓库 Tab 与 worktree Tab 看到同一套「今日项目」合计。
  useEffect(() => {
    if (!panelActive || !todayUsageScope) {
      setTodayStats(null);
      return;
    }
    let cancelled = false;
    setLoadingToday(true);
    void fetchTodayProjectStatsMerged(
      todayUsageScope.projectKey,
      sourceFilter,
      todayUsageScope.projectPaths
    ).then((result) => {
      if (cancelled) return;
      setTodayStats(result);
      setLoadingToday(false);
    });
    return () => {
      cancelled = true;
    };
  }, [panelActive, sourceFilter, todayUsageScope]);

  // 空闲时数据轮询返回 unchanged 不会触发重渲染，需独立 tick 让头部相对时间文案随时间走字
  useEffect(() => {
    if (!panelActive || updatedAt === null) return;
    const timer = window.setInterval(() => {
      setNowTick((prev) => prev + 1);
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [panelActive, updatedAt]);

  const stats = useMemo(() => calculateTokenStats(latestSession), [latestSession]);

  const handleRefresh = useCallback(() => {
    latestRef.current = null;
    setRefreshSeq((prev) => prev + 1);
  }, []);

  // 只有绑定了 cliSessionId 的 Tab 才显示保存按钮；kind 无法解析（非 claude/codex）时按钮 disabled
  const hasBoundCliSessionId = Boolean(terminalSession?.cliSessionId);
  const canSaveToSidebar = terminalSession ? canSave(terminalSession, project) : false;
  const handleSaveToSidebar = useCallback(() => {
    if (!terminalSession) return;
    void saveSession(terminalSession, project);
  }, [saveSession, terminalSession, project]);

  // A7: 实时查询当前项目的 git 分支，初始值为会话静态分支，避免首屏闪烁
  // A6: 通过 pollTrigger 与会话数据轮询共用 10s 节拍
  const currentBranch = useCurrentGitBranch(
    lookupProjectPath,
    panelActive,
    latestSession?.branch ?? null,
    pollTrigger
  );

  // 未绑定 hook 会话时，4 张会话级卡片照常渲染但数据置空（保留图形骨架）
  const boundSession = tokensBound ? latestSession : null;
  const boundStats = tokensBound ? stats : EMPTY_TOKEN_STATS;
  const latestChangesSummary = useMemo(() => buildLatestChangesSummary(boundSession), [boundSession]);
  const diffText = useMemo(
    () => (diffFileChange ? buildLatestChangeDiffText(diffFileChange) : ""),
    [diffFileChange]
  );
  const hasVisibleCard = terminalStatsCardOrder.some((key) => terminalStatsCardVisibility[key]);

  if (!panelActive) return null;

  const projectName = project?.name || latestSession?.project_key || "—";
  const shellLabel = formatStatsShellLabel(terminalSession?.shell ?? project?.shell);

  const emptyDisplaySession: HistorySessionDetail | null =
    !latestSession && sourceFilter && displayProjectPath
      ? {
          session_id: terminalSession?.cliSessionId ?? "—",
          source: sourceFilter,
          project_key: projectName || displayProjectPath,
          title: projectName || displayProjectPath,
          file_path: "",
          cwd: displayProjectPath,
          created_at: Date.now(),
          updated_at: Date.now(),
          message_count: 0,
          branch: null,
          messages: [],
          tool_events: [],
          file_changes: [],
        }
      : null;
  const displaySession = latestSession ?? emptyDisplaySession;

  const renderStatsCard = (cardKey: TerminalStatsCardKey) => {
    if (!terminalStatsCardVisibility[cardKey]) return null;
    const session = displaySession;
    const resolvedProjectPath = displayProjectPath;
    if (!session || !resolvedProjectPath) return null;

    switch (cardKey) {
      case "session":
        return (
          <SessionInfoCard
            key={cardKey}
            session={session}
            statsSession={boundSession}
            projectName={projectName || "—"}
            projectPath={resolvedProjectPath}
            currentBranch={currentBranch}
            shell={shellLabel || "—"}
            sessionId={terminalSession?.cliSessionId ?? session.session_id}
            worktree={activeWorktree}
            onSaveToSidebar={hasBoundCliSessionId ? handleSaveToSidebar : undefined}
            canSaveToSidebar={canSaveToSidebar}
          />
        );
      case "tokenUsage":
        return <TokenUsageCard key={cardKey} stats={boundStats} />;
      case "tokenTrend":
        return <TrendCard key={cardKey} session={boundSession} />;
      case "modelContext":
        return (
          <ModelContextCard
            key={cardKey}
            stats={boundStats}
            session={boundSession}
            displayModel={boundSession?.usage?.current_model ?? boundStats.dominantModel}
            exactContextLimit={boundSession?.usage?.context_window ?? null}
            reasoningEffort={terminalSession?.cliReasoningEffort ?? null}
          />
        );
      case "tools":
        return <ToolsCard key={cardKey} session={boundSession} />;
      case "latestChanges":
        return (
          <LatestChangesCard
            key={cardKey}
            summary={latestChangesSummary}
            onOpenDiff={(fileChange) => setDiffFileChange(fileChange)}
          />
        );
      case "todayUsage":
        return <TodayUsageCard key={cardKey} stats={todayStats} loading={loadingToday} />;
    }
  };

  const containerClassName = embedded
    ? "flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2 font-mono ui-thin-scroll"
    : "relative z-[1] flex w-[188px] shrink-0 flex-col gap-2 overflow-y-auto border-l border-border p-2 font-mono ui-thin-scroll";
  const Container = embedded ? "div" : "aside";
  const containerStyle = {
    backgroundColor: TERM.bg,
    ...TERMINAL_PANEL_SCROLLBAR_STYLE,
  };

  return (
    <Container
      className={containerClassName}
      style={containerStyle}
    >
      <div className="flex items-center justify-between px-1 py-0.5">
        <span className="flex items-center gap-2 text-[11px] font-bold" style={{ color: TERM.fg }}>
          <LiveDot />
          {t("termStats.live")}
          {sourceFilter && (
            <SourcePill source={sourceFilter} />
          )}
        </span>
        <span className="flex items-center gap-1.5 text-[10px]" style={{ color: TERM.dim }}>
          {updatedAt && <span>{formatRelativeTime(updatedAt)}</span>}
          <button
            onClick={handleRefresh}
            className={`ui-focus-ring rounded p-0.5 ${loadingSession ? "animate-spin" : ""}`}
            style={{ color: TERM.cyan }}
            title={t("termStats.refresh")}
            aria-label={t("termStats.refresh")}
          >
            <RefreshCw size={11} />
          </button>
        </span>
      </div>

      {!displayProjectPath ? (
        <EmptyHint text={t("termStats.noProject")} />
      ) : loadingSession && !latestSession ? (
        <EmptyHint text={t("common.loading")} />
      ) : !displaySession ? (
        <EmptyHint text={t("termStats.noSessionRecord", { source: sourceFilter ?? "CLI" })} />
      ) : !hasVisibleCard ? (
        <EmptyHint text={t("termStats.noVisibleCards")} />
      ) : (
        <>
          {terminalStatsCardOrder.map(renderStatsCard)}
        </>
      )}
      {diffFileChange && displayProjectPath && (
        <DiffViewerModal
          open={Boolean(diffFileChange)}
          projectPath={displayProjectPath}
          filePath={diffFileChange.file_path}
          fileName={diffFileChange.file_path.split(/[\\/]/).pop() || diffFileChange.file_path}
          status={diffFileChange.status}
          diffText={diffText}
          onClose={() => setDiffFileChange(null)}
        />
      )}
      {saveSessionDialog}
    </Container>
  );
}
