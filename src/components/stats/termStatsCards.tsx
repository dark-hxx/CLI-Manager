import { Activity, CalendarClock, Coins, Cpu, Wrench } from "lucide-react";
import type { HistorySessionDetail, HistoryToolCount } from "../../lib/types";
import { getContextLimit } from "../../lib/modelPricing";
import type { TodayProjectStats } from "../../stores/historyStore";
import {
  TERM,
  StatCard,
  HeaderPill,
  Row,
  StatChip,
  Donut,
  Sparkline,
  ProgressBar,
  formatCompactCount,
  formatCost,
  useCountUp,
  type TokenStats,
} from "./termStatsUi";

export function TokenUsageCard({ stats }: { stats: TokenStats }) {
  const animatedTotal = useCountUp(stats.totalTokens);
  const animatedCost = useCountUp(stats.estimatedCost);

  return (
    <StatCard
      icon={<Coins size={13} />}
      title="Token 用量"
      headerRight={<HeaderPill>{formatCompactCount(animatedTotal)}</HeaderPill>}
    >
      <div className="flex items-center gap-3">
        <Donut
          segments={[
            { value: stats.inputTokens, color: TERM.green },
            { value: stats.outputTokens, color: TERM.yellow },
            { value: stats.cacheReadTokens, color: TERM.blue },
            { value: stats.cacheCreationTokens, color: TERM.magenta },
          ]}
        >
          <span className="text-[10px] font-bold" style={{ color: TERM.fg }}>
            {formatCompactCount(animatedTotal)}
          </span>
        </Donut>
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
          <StatChip dotColor={TERM.green} label="输入" value={formatCompactCount(stats.inputTokens)} />
          <StatChip dotColor={TERM.yellow} label="输出" value={formatCompactCount(stats.outputTokens)} />
          <StatChip dotColor={TERM.blue} label="缓存读" value={formatCompactCount(stats.cacheReadTokens)} />
          <StatChip dotColor={TERM.magenta} label="缓存写" value={formatCompactCount(stats.cacheCreationTokens)} />
        </div>
      </div>
      <div
        className="mt-2 flex items-baseline justify-between border-t pt-2 text-[11px]"
        style={{ borderColor: TERM.border }}
      >
        <span style={{ color: TERM.dim }}>估算费用</span>
        <span className="text-[14px] font-bold" style={{ color: TERM.green }}>
          {formatCost(animatedCost)}
        </span>
      </div>
    </StatCard>
  );
}

export function ModelContextCard({
  stats,
  session,
}: {
  stats: TokenStats;
  session: HistorySessionDetail | null;
}) {
  // 上限：优先 Codex token_count 事件携带的精确窗口，回退模型映射（含 [1m] → 1M）
  const contextLimit = session?.usage?.context_window ?? getContextLimit(stats.dominantModel);

  // 当前占用：优先后端扫描的最近一次请求上下文，回退前端逐消息查找
  let contextTokens: number | null = session?.usage?.last_context_tokens ?? null;
  if (contextTokens === null && session) {
    // 从后向前找最近一条带 usage 的消息（重复行的 token 已被后端清空）
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      const promptTokens =
        (msg.input_tokens ?? 0) + (msg.cache_read_tokens ?? 0) + (msg.cache_creation_tokens ?? 0);
      if (promptTokens > 0) {
        contextTokens = promptTokens;
        break;
      }
    }
  }

  const usagePercent =
    contextLimit && contextTokens !== null ? (contextTokens / contextLimit) * 100 : null;
  const remaining =
    contextLimit && contextTokens !== null ? Math.max(0, contextLimit - contextTokens) : null;

  const percentColor =
    usagePercent === null
      ? TERM.dim
      : usagePercent >= 80
        ? TERM.red
        : usagePercent >= 50
          ? TERM.yellow
          : TERM.green;
  const animatedPercent = useCountUp(usagePercent ?? 0);
  // 未绑定空态（session 为 null）补骨架占位（徽章/剩余行/进度条），高度与有数据时一致；
  // 非空会话维持原生行为，历史会话面板不受影响
  const isEmpty = !session;

  return (
    <StatCard
      icon={<Cpu size={13} />}
      title="模型与上下文"
      headerRight={
        usagePercent !== null ? (
          <HeaderPill color={percentColor}>{animatedPercent.toFixed(1)}%</HeaderPill>
        ) : isEmpty ? (
          <HeaderPill color={TERM.dim}>—</HeaderPill>
        ) : undefined
      }
    >
      <Row label="模型" value={stats.dominantModel || "—"} color={TERM.magenta} />
      <Row
        label="当前上下文"
        value={contextTokens !== null ? formatCompactCount(contextTokens) : "—"}
        color={TERM.fg}
      />
      <Row
        label="上下文上限"
        value={contextLimit ? formatCompactCount(contextLimit) : "—"}
        color={TERM.fg}
      />
      {remaining !== null ? (
        <Row label="剩余空间" value={formatCompactCount(remaining)} color={percentColor} />
      ) : isEmpty ? (
        <Row label="剩余空间" value="—" color={TERM.dim} />
      ) : null}
      {usagePercent !== null ? (
        <div className="mt-1.5">
          <ProgressBar ratio={usagePercent / 100} color={percentColor} />
        </div>
      ) : isEmpty ? (
        <div className="mt-1.5">
          <ProgressBar ratio={0} color={TERM.dim} />
        </div>
      ) : null}
    </StatCard>
  );
}

const TREND_POINT_LIMIT = 40;

export function TrendCard({ session }: { session: HistorySessionDetail | null }) {
  const points: number[] = [];
  const backendTrend = session?.usage?.token_trend ?? [];
  let sourceLabel = "每条消息 输入+输出";
  if (session) {
    if (backendTrend.length > 0) {
      sourceLabel = "每次请求 Token 增量";
      for (const point of backendTrend) {
        const tokens =
          point.total_tokens
          || point.input_tokens + point.output_tokens + point.cache_read_tokens + point.cache_creation_tokens;
        if (tokens > 0) points.push(tokens);
      }
    } else {
      for (const msg of session.messages) {
        const tokens = (msg.input_tokens ?? 0) + (msg.output_tokens ?? 0);
        if (tokens > 0) points.push(tokens);
      }
    }
  }
  const recent = points.slice(-TREND_POINT_LIMIT);
  const peakTokens = recent.length > 0 ? Math.max(...recent) : 0;
  const hasTrend = recent.length >= 2;
  // 未绑定空态（session 为 null）补骨架占位，使高度与有数据时一致；
  // 非空会话维持原生行为，历史会话面板不受影响
  const isEmpty = !session;

  return (
    <StatCard
      icon={<Activity size={13} />}
      title="Token 趋势"
      headerRight={
        hasTrend ? (
          <HeaderPill color={TERM.cyan}>{recent.length} 条</HeaderPill>
        ) : isEmpty ? (
          <HeaderPill color={TERM.cyan}>—</HeaderPill>
        ) : undefined
      }
    >
      {hasTrend ? (
        <Sparkline points={recent} color={TERM.cyan} height={40} />
      ) : (
        <div
          className="flex items-center justify-center rounded-md text-[10px]"
          style={{ height: 40, color: TERM.dim, backgroundColor: TERM.cardInner }}
        >
          {recent.length === 1 ? `仅 1 个趋势点：${formatCompactCount(peakTokens)}` : "暂无趋势数据"}
        </div>
      )}
      {hasTrend ? (
        <div className="mt-1 flex justify-between text-[10px]" style={{ color: TERM.dim }}>
          <span>{sourceLabel}</span>
          <span>
            峰值 {formatCompactCount(peakTokens)}
          </span>
        </div>
      ) : isEmpty ? (
        <div className="mt-1 flex justify-between text-[10px]" style={{ color: TERM.dim }}>
          <span>{sourceLabel}</span>
          <span>峰值 {formatCompactCount(peakTokens)}</span>
        </div>
      ) : null}
    </StatCard>
  );
}

const TOOL_LIST_LIMIT = 4;

function ToolCountList({
  label,
  color,
  items,
}: {
  label: string;
  color: string;
  items: HistoryToolCount[];
}) {
  const top = items.slice(0, TOOL_LIST_LIMIT);
  const restCount = items.length - top.length;
  return (
    <div className="mt-1.5 first:mt-0">
      <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold" style={{ color }}>
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
        {label}
      </div>
      {top.map((item) => (
        <div
          key={item.name}
          className="flex items-baseline justify-between gap-2 text-[11px] leading-5"
        >
          <span className="truncate" style={{ color: TERM.fg }} title={item.name}>
            {item.name}
          </span>
          <span className="shrink-0 font-bold" style={{ color }}>
            {formatCompactCount(item.count)}
          </span>
        </div>
      ))}
      {restCount > 0 && (
        <div className="text-[10px]" style={{ color: TERM.dim }}>
          +{restCount} 更多
        </div>
      )}
    </div>
  );
}

export function ToolsCard({ session }: { session: HistorySessionDetail | null }) {
  const usage = session?.usage;
  const toolCalls = usage?.tool_call_count ?? 0;
  const mcpCalls = usage?.mcp_calls ?? [];
  const skillCalls = usage?.skill_calls ?? [];
  const builtinCalls = usage?.builtin_calls ?? [];
  // 未绑定空态（session 为 null）补徽章占位，顶部与有数据时一致
  const isEmpty = !session;

  return (
    <StatCard
      icon={<Wrench size={13} />}
      title="工具与扩展"
      headerRight={
        toolCalls > 0 ? (
          <HeaderPill color={TERM.blue}>{formatCompactCount(toolCalls)} 次</HeaderPill>
        ) : isEmpty ? (
          <HeaderPill color={TERM.blue}>0 次</HeaderPill>
        ) : undefined
      }
    >
      {mcpCalls.length === 0 && skillCalls.length === 0 && builtinCalls.length === 0 ? (
        <div className="text-[11px]" style={{ color: TERM.dim }}>
          暂无工具调用
        </div>
      ) : (
        <>
          {builtinCalls.length > 0 && (
            <ToolCountList label="内置工具" color={TERM.green} items={builtinCalls} />
          )}
          {mcpCalls.length > 0 && <ToolCountList label="MCP" color={TERM.cyan} items={mcpCalls} />}
          {skillCalls.length > 0 && (
            <ToolCountList label="Skill / 命令" color={TERM.magenta} items={skillCalls} />
          )}
        </>
      )}
    </StatCard>
  );
}

export function TodayUsageCard({
  stats,
  loading,
}: {
  stats: TodayProjectStats | null;
  loading: boolean;
}) {
  return (
    <StatCard
      icon={<CalendarClock size={13} />}
      title="今日项目用量"
      headerRight={
        stats && stats.sessions > 0 ? <HeaderPill>{stats.sessions} 会话</HeaderPill> : undefined
      }
    >
      {loading && !stats ? (
        <div className="text-[11px]" style={{ color: TERM.dim }}>
          加载中…
        </div>
      ) : stats && stats.sessions > 0 ? (
        <div className="grid grid-cols-2 gap-1.5">
          <StatChip
            dotColor={TERM.yellow}
            label="Token"
            value={formatCompactCount(stats.totalTokens)}
            valueColor={TERM.yellow}
          />
          <StatChip
            dotColor={TERM.green}
            label="费用"
            value={formatCost(stats.totalCostUsd)}
            valueColor={TERM.green}
          />
        </div>
      ) : (
        <div className="text-[11px]" style={{ color: TERM.dim }}>
          今日暂无会话
        </div>
      )}
    </StatCard>
  );
}
