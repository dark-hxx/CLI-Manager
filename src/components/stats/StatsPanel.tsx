import { useEffect, useMemo, useState } from "react";
import { BarChart3, RefreshCw, X } from "lucide-react";
import type { HistorySessionSummary, HistorySessionView } from "../../lib/types";
import { useHistoryStore } from "../../stores/historyStore";
import { TimelineHeatmap } from "./TimelineHeatmap";
import { StatsTrendChart } from "./StatsTrendChart";
import { StatsTokenDonut } from "./StatsTokenDonut";
import { StatsProjectBar } from "./StatsProjectBar";
import { StatsModelComposition } from "./StatsModelComposition";
import { StatsTokenTrendChart } from "./StatsTokenTrendChart";
import { StatsSourceComparisonChart } from "./StatsSourceComparisonChart";
import { StatsProjectEfficiencyScatter } from "./StatsProjectEfficiencyScatter";
import { StatsHourlyActivityChart } from "./StatsHourlyActivityChart";
import { Skeleton } from "../ui/Skeleton";

interface StatsPanelProps {
  open: boolean;
  sessions: HistorySessionView[];
  onClose: () => void;
  onOpenSession: (sessionKey: string) => Promise<void>;
}

const DAY_SESSION_PAGE_SIZE = 120;

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDay(dayStartUtc: number): string {
  if (!Number.isFinite(dayStartUtc) || dayStartUtc <= 0) return "-";
  return new Date(dayStartUtc).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}

function formatDateTime(ts: number | null): string {
  if (!ts || !Number.isFinite(ts)) return "-";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function makeSessionKey(summary: HistorySessionSummary): string {
  return `${summary.source}:${summary.session_id}:${summary.file_path}`;
}

function StatsSkeleton() {
  return (
    <div className="space-y-3 animate-fade-in">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-md border border-border bg-bg-secondary p-2 space-y-2">
            <Skeleton className="h-2.5 w-1/2" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {[1, 2].map((i) => (
          <div key={i} className="rounded-md border border-border bg-bg-secondary p-3 space-y-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2.5 w-5/6" />
            <Skeleton className="h-2.5 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatsPanel({ open, sessions, onClose, onOpenSession }: StatsPanelProps) {
  const loadingStats = useHistoryStore((s) => s.loadingStats);
  const stats = useHistoryStore((s) => s.stats);
  const statsError = useHistoryStore((s) => s.statsError);
  const statsUpdatedAt = useHistoryStore((s) => s.statsUpdatedAt);
  const sourceFilter = useHistoryStore((s) => s.sourceFilter);
  const loadStats = useHistoryStore((s) => s.loadStats);

  const [projectKey, setProjectKey] = useState("");
  const [rangeDays, setRangeDays] = useState(30);
  const [selectedDayStart, setSelectedDayStart] = useState<number | null>(null);
  const [dayVisibleCount, setDayVisibleCount] = useState(DAY_SESSION_PAGE_SIZE);

  const projectOptions = useMemo(() => {
    const projectSet = new Set<string>();
    for (const item of sessions) {
      if (item.project_key) projectSet.add(item.project_key);
    }
    return Array.from(projectSet).sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  useEffect(() => {
    if (!open) return;
    void loadStats({
      projectKey: projectKey || null,
      rangeDays,
    }).catch(() => {
      // error state is already managed in store
    });
  }, [open, projectKey, rangeDays, loadStats]);

  useEffect(() => {
    if (!stats) return;
    if (selectedDayStart === null) return;
    const exists = stats.heatmap.some((day) => day.day_start_utc === selectedDayStart);
    if (!exists) {
      setSelectedDayStart(null);
      setDayVisibleCount(DAY_SESSION_PAGE_SIZE);
    }
  }, [stats, selectedDayStart]);

  useEffect(() => {
    setDayVisibleCount(DAY_SESSION_PAGE_SIZE);
  }, [selectedDayStart]);

  const selectedDay = useMemo(() => {
    if (!stats || selectedDayStart === null) return null;
    return stats.heatmap.find((item) => item.day_start_utc === selectedDayStart) ?? null;
  }, [stats, selectedDayStart]);

  const visibleDaySessions = useMemo(() => {
    if (!selectedDay) return [];
    return selectedDay.session_refs.slice(0, dayVisibleCount);
  }, [selectedDay, dayVisibleCount]);

  const sourceLabel = sourceFilter === "all" ? "全部来源" : sourceFilter;
  const projectLabel = projectKey || "全部项目";

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 57, backgroundColor: "rgba(0, 0, 0, 0.45)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="h-[min(86vh,860px)] w-full max-w-6xl overflow-hidden rounded-lg border border-border bg-bg-primary flex flex-col"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-text-primary">
            <BarChart3 size={15} />
            分析看板
          </div>
          <button
            onClick={onClose}
            aria-label="关闭分析看板"
            className="ui-btn h-7 w-7 p-0"
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <select
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value)}
            className="ui-input shrink-0 px-2 py-1 text-xs"
            aria-label="项目过滤"
          >
            <option value="">全部项目</option>
            {projectOptions.map((project) => (
              <option key={project} value={project}>
                {project}
              </option>
            ))}
          </select>

          <select
            value={rangeDays}
            onChange={(e) => setRangeDays(Number(e.target.value) || 30)}
            className="ui-input shrink-0 px-2 py-1 text-xs"
            aria-label="时间范围"
          >
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
          </select>

          <button
            onClick={() => {
              void loadStats({
                projectKey: projectKey || null,
                rangeDays,
                force: true,
              }).catch(() => {
                // error state is already managed in store
              });
            }}
            aria-label="刷新统计"
            className="ui-btn text-xs"
          >
            <RefreshCw size={12} className={loadingStats ? "animate-spin" : ""} />
            刷新
          </button>

          <div className="ml-auto text-[12px] font-medium text-text-secondary">
            来源：{sourceLabel} ｜ 范围：最近 {rangeDays} 天
          </div>
          <div className="w-full text-[12px] font-medium text-text-secondary">
            最近刷新：{formatDateTime(statsUpdatedAt)}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          {loadingStats && !stats && <StatsSkeleton />}

          {!loadingStats && statsError && (
            <div className="rounded-xl border border-border bg-bg-secondary p-3 text-[12px] text-danger space-y-2">
              <div>统计加载失败：{statsError}</div>
              <button
                onClick={() => {
                  void loadStats({
                    projectKey: projectKey || null,
                    rangeDays,
                    force: true,
                  }).catch(() => {
                    // error state is already managed in store
                  });
                }}
                className="ui-btn text-xs"
              >
                <RefreshCw size={12} />
                重试
              </button>
            </div>
          )}

          {stats && (
            <>
              {loadingStats && (
                <div className="text-[12px] font-medium" style={{ color: "var(--text-muted)" }}>
                  正在更新统计...
                </div>
              )}

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <div className="rounded-xl border border-border bg-bg-secondary p-3">
                  <div className="text-[12px] font-medium text-text-muted">
                    会话数
                  </div>
                  <div className="mt-1 text-[20px] font-semibold text-text-primary">
                    {formatCount(stats.total_sessions)}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-bg-secondary p-3">
                  <div className="text-[12px] font-medium text-text-muted">
                    消息数
                  </div>
                  <div className="mt-1 text-[20px] font-semibold text-text-primary">
                    {formatCount(stats.total_messages)}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-bg-secondary p-3">
                  <div className="text-[12px] font-medium text-text-muted">
                    输入 Token
                  </div>
                  <div className="mt-1 text-[20px] font-semibold text-text-primary">
                    {formatCount(stats.total_input_tokens)}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-bg-secondary p-3">
                  <div className="text-[12px] font-medium text-text-muted">
                    输出 Token
                  </div>
                  <div className="mt-1 text-[20px] font-semibold text-text-primary">
                    {formatCount(stats.total_output_tokens)}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-bg-secondary p-4">
                <div className="mb-2 text-[13px] font-semibold text-text-primary">统计口径说明</div>
                <div className="space-y-1.5 text-[12px] leading-6 text-text-secondary">
                  <div>会话数/消息数：按当前来源、项目与时间范围过滤后聚合。</div>
                  <div>Token：来自历史日志 `usage` 字段汇总（缺失 usage 的消息按 0 计）。</div>
                  <div>当前口径：来源 {sourceLabel}，项目 {projectLabel}，时间 最近 {rangeDays} 天。</div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <div className="lg:col-span-2">
                  <StatsTrendChart
                    days={stats.heatmap}
                    selectedDayStart={selectedDayStart}
                    onSelectDay={(day) => setSelectedDayStart(day.day_start_utc)}
                  />
                </div>
                <StatsTokenDonut
                  inputTokens={stats.total_input_tokens}
                  outputTokens={stats.total_output_tokens}
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <StatsProjectBar
                  items={stats.project_ranking}
                  selectedProjectKey={projectKey}
                  onSelectProject={(nextProjectKey) => {
                    setProjectKey((prev) => (prev === nextProjectKey ? "" : nextProjectKey));
                  }}
                  onClearProject={() => setProjectKey("")}
                />

                <StatsModelComposition items={stats.model_distribution} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <StatsTokenTrendChart items={stats.daily_series} />
                <StatsSourceComparisonChart items={stats.source_distribution} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <StatsProjectEfficiencyScatter items={stats.project_efficiency} />
                <StatsHourlyActivityChart items={stats.hourly_activity} />
              </div>

              <TimelineHeatmap
                days={stats.heatmap}
                selectedDayStart={selectedDayStart}
                onSelectDay={(day) => setSelectedDayStart(day.day_start_utc)}
              />

              <div className="rounded-xl border border-border bg-bg-secondary p-4">
                <div className="mb-2 text-[13px] font-semibold text-text-primary">
                  {selectedDay ? `${formatDay(selectedDay.day_start_utc)} 会话` : "选择热力图日期查看会话"}
                </div>
                {!selectedDay && (
                  <div className="text-[12px] font-medium text-text-muted">
                    点击上方热力图方块后，这里会展示当天会话清单
                  </div>
                )}
                {selectedDay && selectedDay.session_refs.length === 0 && (
                  <div className="text-[12px] font-medium text-text-muted">
                    当天无会话
                  </div>
                )}

                {visibleDaySessions.map((session) => (
                  <button
                    key={makeSessionKey(session)}
                    onClick={() => {
                      void onOpenSession(makeSessionKey(session)).then(() => onClose());
                    }}
                    className="ui-list-row w-full border-b border-border py-2 text-left last:border-b-0"
                  >
                    <div className="truncate text-[13px] font-semibold text-text-primary">
                      {session.title}
                    </div>
                    <div className="ui-dev-label mt-0.5 text-[11px] text-text-muted">
                      {session.source} · {session.project_key} · {session.message_count} 条消息
                    </div>
                  </button>
                ))}

                {selectedDay && dayVisibleCount < selectedDay.session_refs.length && (
                  <button
                    onClick={() => setDayVisibleCount((prev) => prev + DAY_SESSION_PAGE_SIZE)}
                    className="ui-btn mt-2 w-full text-xs"
                  >
                    加载更多 ({dayVisibleCount}/{selectedDay.session_refs.length})
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
