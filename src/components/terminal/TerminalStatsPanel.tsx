import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderGit2, GitBranch, RefreshCw } from "lucide-react";
import type { HistorySessionDetail, HistorySource } from "../../lib/types";
import {
  fetchLatestProjectSessionDetail,
  fetchTodayProjectStats,
  type TodayProjectStats,
} from "../../stores/historyStore";
import { useProjectStore } from "../../stores/projectStore";
import { useTerminalStore } from "../../stores/terminalStore";
import {
  TERM,
  SOURCE_COLORS,
  StatCard,
  HeaderPill,
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
import { TokenUsageCard, ModelContextCard, TrendCard, ToolsCard, TodayUsageCard } from "../stats/termStatsCards";

interface TerminalStatsPanelProps {
  activeSessionId: string | null;
  open: boolean;
}

const POLL_INTERVAL_MS = 10_000;

const ROLE_COLORS: Record<string, string> = {
  user: TERM.green,
  assistant: TERM.blue,
  tool: TERM.yellow,
};

// 来源徽章配色：claude 黄 / codex 青，与终端 Tab 的 CLI 区分一致
// 从终端会话的启动命令/标题推断该终端运行的 CLI（项目设置中配置的 cli_tool 会进入两者）
function inferHistorySource(haystack: string): HistorySource | null {
  const lower = haystack.toLowerCase();
  if (/\bcodex\b/.test(lower)) return "codex";
  if (/\bclaude\b/.test(lower)) return "claude";
  return null;
}

function SessionInfoCard({ session, projectName, projectPath }: {
  session: HistorySessionDetail;
  projectName: string;
  projectPath: string;
}) {
  const roleCounts = useMemo(() => {
    const counts: Record<string, number> = { user: 0, assistant: 0, tool: 0 };
    for (const msg of session.messages) {
      const key = msg.role in counts ? msg.role : "tool";
      counts[key] += 1;
    }
    return counts;
  }, [session.messages]);

  const duration = formatDuration(session.updated_at - session.created_at);
  const branch = session.branch || "—";

  return (
    <StatCard
      icon={<FolderGit2 size={13} />}
      title="会话"
      headerRight={
        <HeaderPill color={SOURCE_COLORS[session.source] ?? TERM.cyan}>{session.source}</HeaderPill>
      }
    >
      <Row label="项目" value={projectName} title={projectName} />
      <Row label="路径" value={truncatePath(projectPath, 3)} color={TERM.dim} title={projectPath} />
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-5">
        <span className="flex shrink-0 items-center gap-1" style={{ color: TERM.dim }}>
          <GitBranch size={10} />
          分支
        </span>
        <span className="truncate text-right" style={{ color: TERM.magenta }} title={branch}>
          {branch}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <StatChip dotColor={TERM.cyan} label="消息数" value={String(session.messages.length)} />
        <StatChip dotColor={TERM.green} label="会话时长" value={duration} />
      </div>

      <div className="mt-2">
        <SegmentedBar
          parts={[
            { value: roleCounts.user, color: ROLE_COLORS.user, label: "用户" },
            { value: roleCounts.assistant, color: ROLE_COLORS.assistant, label: "助手" },
            { value: roleCounts.tool, color: ROLE_COLORS.tool, label: "工具" },
          ]}
        />
        <div className="mt-1 flex gap-3 text-[10px]" style={{ color: TERM.dim }}>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ROLE_COLORS.user }} />
            用户 {roleCounts.user}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ROLE_COLORS.assistant }} />
            助手 {roleCounts.assistant}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ROLE_COLORS.tool }} />
            工具 {roleCounts.tool}
          </span>
        </div>
      </div>
    </StatCard>
  );
}

export function TerminalStatsPanel({ activeSessionId, open }: TerminalStatsPanelProps) {
  const terminalSessions = useTerminalStore((state) => state.sessions);
  const projects = useProjectStore((state) => state.projects);

  const [latestSession, setLatestSession] = useState<HistorySessionDetail | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [todayStats, setTodayStats] = useState<TodayProjectStats | null>(null);
  const [loadingToday, setLoadingToday] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const latestRef = useRef<HistorySessionDetail | null>(null);
  const lastPathRef = useRef<string | null>(null);

  const terminalSession = useMemo(
    () => terminalSessions.find((session) => session.id === activeSessionId) ?? null,
    [terminalSessions, activeSessionId]
  );

  const project = useMemo(
    () => projects.find((item) => item.id === terminalSession?.projectId) ?? null,
    [projects, terminalSession?.projectId]
  );

  const projectPath = terminalSession?.cwd || project?.path || null;

  // 终端运行的 CLI 工具（claude/codex），来自项目设置；推断不出则不过滤
  const sourceFilter = useMemo(
    () =>
      inferHistorySource(
        `${terminalSession?.startupCmd ?? ""} ${terminalSession?.title ?? ""} ${project?.cli_tool ?? ""}`
      ),
    [terminalSession?.startupCmd, terminalSession?.title, project?.cli_tool]
  );

  // 任一终端已绑定过 CLI 会话 ID，说明 hook 链路可用。此时若本 CLI 终端仍未拿到
  // 自己的 cliSessionId，视为「会话尚未识别」，显示等待空态而非回退项目最近会话，
  // 避免新开/未发首条指令的终端串显同项目另一个窗口的数据。
  const anyCliBound = useMemo(
    () => terminalSessions.some((session) => Boolean(session.cliSessionId)),
    [terminalSessions]
  );
  const awaitingSessionId = Boolean(sourceFilter) && anyCliBound && !terminalSession?.cliSessionId;

  // 轮询该项目最近一次 CLI 会话：updated_at 未变化时跳过 jsonl 重解析
  useEffect(() => {
    if (!open || !projectPath || awaitingSessionId) {
      lastPathRef.current = null;
      latestRef.current = null;
      setLatestSession(null);
      if (awaitingSessionId) setUpdatedAt(null);
      return;
    }
    // 切换 Tab（项目路径或 CLI 来源变化）时立即清空旧数据，避免短暂展示错误的模型/上下文
    const scopeKey = `${projectPath}|${sourceFilter ?? ""}|${terminalSession?.cliSessionId ?? ""}`;
    if (lastPathRef.current !== scopeKey) {
      lastPathRef.current = scopeKey;
      latestRef.current = null;
      setLatestSession(null);
      setUpdatedAt(null);
    }
    let cancelled = false;

    const load = async (initial: boolean) => {
      if (initial) setLoadingSession(true);
      const current = latestRef.current;
      const prev = current
        ? { filePath: current.file_path, updatedAt: current.updated_at }
        : undefined;
      const result = await fetchLatestProjectSessionDetail(projectPath, prev, sourceFilter, terminalSession?.cliSessionId);
      if (cancelled) return;
      if (result !== "unchanged") {
        latestRef.current = result;
        setLatestSession(result);
        setUpdatedAt(Date.now());
      }
      if (initial) {
        setLoadingSession(false);
        if (updatedAt === null) setUpdatedAt(Date.now());
      }
    };

    void load(true);
    const timer = window.setInterval(() => {
      void load(false);
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // activeSessionId 入依赖：切换 Tab 时立即重新核对最近会话（unchanged 时开销仅一次列表查询）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectPath, sourceFilter, terminalSession?.cliSessionId, refreshSeq, activeSessionId, awaitingSessionId]);

  // 今日项目用量：会话数据变化时同步刷新（与终端 CLI 来源保持一致）
  useEffect(() => {
    if (!open || !latestSession) {
      setTodayStats(null);
      return;
    }
    let cancelled = false;
    setLoadingToday(true);
    void fetchTodayProjectStats(latestSession.project_key, sourceFilter).then((result) => {
      if (cancelled) return;
      setTodayStats(result);
      setLoadingToday(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, latestSession, sourceFilter]);

  // 空闲时数据轮询返回 unchanged 不会触发重渲染，需独立 tick 让头部相对时间文案随时间走字
  useEffect(() => {
    if (!open || updatedAt === null) return;
    const timer = window.setInterval(() => {
      setNowTick((prev) => prev + 1);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [open, updatedAt]);

  const stats = useMemo(() => calculateTokenStats(latestSession), [latestSession]);

  const handleRefresh = useCallback(() => {
    latestRef.current = null;
    setRefreshSeq((prev) => prev + 1);
  }, []);

  if (!open) return null;

  const projectName = project?.name || latestSession?.project_key || "—";

  return (
    <aside
      className="flex w-[290px] shrink-0 flex-col gap-2 overflow-y-auto border-l border-border p-2 font-mono"
      style={{ backgroundColor: TERM.bg }}
    >
      <div className="flex items-center justify-between px-1 py-0.5">
        <span className="flex items-center gap-2 text-[11px] font-bold" style={{ color: TERM.fg }}>
          <LiveDot />
          实时统计
          {sourceFilter && (
            <HeaderPill color={SOURCE_COLORS[sourceFilter] ?? TERM.cyan}>{sourceFilter}</HeaderPill>
          )}
        </span>
        <span className="flex items-center gap-1.5 text-[10px]" style={{ color: TERM.dim }}>
          {updatedAt && <span>{formatRelativeTime(updatedAt)}</span>}
          <button
            onClick={handleRefresh}
            className={`ui-focus-ring rounded p-0.5 ${loadingSession ? "animate-spin" : ""}`}
            style={{ color: TERM.cyan }}
            title="刷新统计"
            aria-label="刷新统计"
          >
            <RefreshCw size={11} />
          </button>
        </span>
      </div>

      {!projectPath ? (
        <EmptyHint text="当前终端未关联项目" />
      ) : awaitingSessionId ? (
        <EmptyHint text={`等待 ${sourceFilter} 会话识别（发送一次指令后显示）`} />
      ) : loadingSession && !latestSession ? (
        <EmptyHint text="加载中…" />
      ) : !latestSession ? (
        <EmptyHint text={`该项目暂无 ${sourceFilter ?? "CLI"} 会话记录`} />
      ) : (
        <>
          <SessionInfoCard session={latestSession} projectName={projectName} projectPath={projectPath} />
          <TokenUsageCard stats={stats} />
          <TrendCard session={latestSession} />
          <ModelContextCard stats={stats} session={latestSession} />
          <ToolsCard session={latestSession} />
          <TodayUsageCard stats={todayStats} loading={loadingToday} />
        </>
      )}
    </aside>
  );
}
