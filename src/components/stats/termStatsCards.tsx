import { Activity, CalendarClock, Coins, Cpu, FileCode2, GitCompareArrows, Wrench } from "lucide-react";
import type { HistoryFileChangeSummary, HistorySessionDetail, HistoryToolCount } from "../../lib/types";
import { VendorIcon, inferVendor } from "../VendorIcon";
import { resolveContextLimit } from "../../lib/modelPricing";
import type { TodayProjectStats } from "../../stores/historyStore";
import { useI18n } from "../../lib/i18n";
import {
  TERM_PANEL,
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
  type SparkPoint,
} from "./termStatsUi";

function formatReasoningEffort(value: string | null | undefined): string {
  return value?.trim() || "—";
}

const TREND_MODEL_COLORS = [
  TERM_PANEL.cyan,
  TERM_PANEL.magenta,
  TERM_PANEL.yellow,
  TERM_PANEL.blue,
  TERM_PANEL.green,
  TERM_PANEL.red,
] as const;

function colorForTrendModel(model: string | null | undefined): string {
  const value = model?.trim();
  if (!value) return TERM_PANEL.cyan;
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return TREND_MODEL_COLORS[hash % TREND_MODEL_COLORS.length];
}

export function TokenUsageCard({ stats }: { stats: TokenStats }) {
  const { t } = useI18n();
  const animatedTotal = useCountUp(stats.totalTokens);
  const animatedCost = useCountUp(stats.estimatedCost);

  return (
    <StatCard
      icon={<Coins size={13} />}
      iconColor={TERM_PANEL.yellow}
      title={t("termStats.tokenUsage")}
      headerRight={<HeaderPill>{formatCompactCount(animatedTotal)}</HeaderPill>}
    >
      <div className="flex items-center gap-3">
        <Donut
          segments={[
            { value: stats.inputTokens, color: TERM_PANEL.green },
            { value: stats.outputTokens, color: TERM_PANEL.yellow },
            { value: stats.cacheReadTokens, color: TERM_PANEL.blue },
            { value: stats.cacheCreationTokens, color: TERM_PANEL.magenta },
          ]}
        >
          <span className="text-[10px] font-bold" style={{ color: TERM_PANEL.fg }}>
            {formatCompactCount(animatedTotal)}
          </span>
        </Donut>
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
          <StatChip dotColor={TERM_PANEL.green} label={t("termStats.input")} value={formatCompactCount(stats.inputTokens)} />
          <StatChip dotColor={TERM_PANEL.yellow} label={t("termStats.output")} value={formatCompactCount(stats.outputTokens)} />
          <StatChip dotColor={TERM_PANEL.blue} label={t("termStats.cacheHit")} value={formatCompactCount(stats.cacheReadTokens)} />
          <StatChip dotColor={TERM_PANEL.magenta} label={t("termStats.cacheWrite")} value={formatCompactCount(stats.cacheCreationTokens)} />
        </div>
      </div>
      <div
        className="mt-2 flex items-baseline justify-between border-t pt-2 text-[11px]"
        style={{ borderColor: TERM_PANEL.border }}
      >
        <span style={{ color: TERM_PANEL.dim }}>{t("termStats.estimatedCost")}</span>
        <span className="text-[14px] font-bold" style={{ color: TERM_PANEL.green }}>
          {formatCost(animatedCost)}
        </span>
      </div>
    </StatCard>
  );
}

export function ModelContextCard({
  stats,
  session,
  displayModel,
  exactContextLimit,
  reasoningEffort,
}: {
  stats: TokenStats;
  session: HistorySessionDetail | null;
  displayModel?: string | null;
  exactContextLimit?: number | null;
  reasoningEffort?: string | null;
}) {
  const { t } = useI18n();
  const model = displayModel ?? stats.dominantModel;
  const contextLimit = resolveContextLimit(model, exactContextLimit ?? session?.usage?.context_window);

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
  const displayedReasoningEffort = formatReasoningEffort(reasoningEffort ?? session?.usage?.reasoning_effort);

  const percentColor =
    usagePercent === null
      ? TERM_PANEL.dim
      : usagePercent >= 80
        ? TERM_PANEL.red
        : usagePercent >= 50
          ? TERM_PANEL.yellow
          : TERM_PANEL.green;
  const animatedPercent = useCountUp(usagePercent ?? 0);
  // 未绑定空态（session 为 null）补骨架占位（徽章/剩余行/进度条），高度与有数据时一致；
  // 非空会话维持原生行为，历史会话面板不受影响
  const isEmpty = !session;
  const modelVendor = inferVendor(model);

  return (
    <StatCard
      icon={<Cpu size={13} />}
      iconColor={TERM_PANEL.magenta}
      title={t("termStats.modelContext")}
      headerRight={
        usagePercent !== null ? (
          <HeaderPill color={percentColor}>{animatedPercent.toFixed(1)}%</HeaderPill>
        ) : isEmpty ? (
          <HeaderPill color={TERM_PANEL.dim}>—</HeaderPill>
        ) : undefined
      }
    >
      <div className="flex items-center justify-between gap-2 text-[11px] leading-5">
        <span className="shrink-0" style={{ color: TERM_PANEL.dim }}>{t("termStats.model")}</span>
        <span
          className="flex min-w-0 items-center gap-1 truncate text-right"
          style={{ color: TERM_PANEL.magenta }}
          title={model || "—"}
        >
          {modelVendor && <VendorIcon vendor={modelVendor} size={12} />}
          <span className="truncate">{model || "—"}</span>
        </span>
      </div>
      <Row
        label={t("termStats.reasoningEffort")}
        value={displayedReasoningEffort}
        color={displayedReasoningEffort === "—" ? TERM_PANEL.dim : TERM_PANEL.magenta}
      />
      <Row
        label={t("termStats.currentContext")}
        value={contextTokens !== null ? formatCompactCount(contextTokens) : "—"}
        color={TERM_PANEL.fg}
      />
      <Row
        label={t("termStats.contextLimit")}
        value={contextLimit ? formatCompactCount(contextLimit) : "—"}
        color={TERM_PANEL.fg}
      />
      {remaining !== null ? (
        <Row label={t("termStats.remaining")} value={formatCompactCount(remaining)} color={percentColor} />
      ) : isEmpty ? (
        <Row label={t("termStats.remaining")} value="—" color={TERM_PANEL.dim} />
      ) : null}
      {usagePercent !== null ? (
        <div className="mt-1.5">
          <ProgressBar ratio={usagePercent / 100} color={percentColor} />
        </div>
      ) : isEmpty ? (
        <div className="mt-1.5">
          <ProgressBar ratio={0} color={TERM_PANEL.dim} />
        </div>
      ) : null}
    </StatCard>
  );
}

export function TrendCard({ session }: { session: HistorySessionDetail | null }) {
  const { t } = useI18n();
  const trend: SparkPoint[] = [];
  const backendTrend = session?.usage?.token_trend ?? [];
  let sourceLabel = t("termStats.messageInputOutput");
  if (session) {
    if (backendTrend.length > 0) {
      sourceLabel = t("termStats.requestTokenDelta");
      for (const point of backendTrend) {
        const total =
          point.total_tokens
          || point.input_tokens + point.output_tokens + point.cache_read_tokens + point.cache_creation_tokens;
        if (total > 0) {
          const model = point.model?.trim() || null;
          trend.push({
            total,
            input: point.input_tokens,
            output: point.output_tokens,
            cacheRead: point.cache_read_tokens,
            cacheCreation: point.cache_creation_tokens,
            model,
            color: colorForTrendModel(model),
          });
        }
      }
    } else {
      for (const msg of session.messages) {
        const input = msg.input_tokens ?? 0;
        const output = msg.output_tokens ?? 0;
        const total = input + output;
        if (total > 0) {
          const model = msg.model?.trim() || null;
          trend.push({ total, input, output, model, color: colorForTrendModel(model) });
        }
      }
    }
  }
  const chartPoints = trend;
  const values = chartPoints.map((p) => p.total);
  const peakTokens = values.length > 0 ? Math.max(...values) : 0;
  const hasTrend = chartPoints.length >= 2;
  // 未绑定空态（session 为 null）补骨架占位，使高度与有数据时一致；
  // 非空会话维持原生行为，历史会话面板不受影响
  const isEmpty = !session;

  return (
    <StatCard
      icon={<Activity size={13} />}
      iconColor={TERM_PANEL.cyan}
      title={t("termStats.tokenTrend")}
      headerRight={
        hasTrend ? (
          <HeaderPill color={TERM_PANEL.cyan}>{t("termStats.trendPointCount", { count: chartPoints.length })}</HeaderPill>
        ) : isEmpty ? (
          <HeaderPill color={TERM_PANEL.cyan}>—</HeaderPill>
        ) : undefined
      }
    >
      {hasTrend ? (
        <Sparkline points={values} details={chartPoints} color={TERM_PANEL.cyan} height={40} />
      ) : (
        <div
          className="flex items-center justify-center rounded-md text-[10px]"
          style={{ height: 40, color: TERM_PANEL.dim, backgroundColor: TERM_PANEL.cardInner }}
        >
          {chartPoints.length === 1
            ? t("termStats.singleTrendPoint", { tokens: formatCompactCount(peakTokens) })
            : t("termStats.noTrendData")}
        </div>
      )}
      {hasTrend ? (
        <div className="mt-1 flex justify-between text-[10px]" style={{ color: TERM_PANEL.dim }}>
          <span>{sourceLabel}</span>
          <span>
            {t("termStats.peak", { value: formatCompactCount(peakTokens) })}
          </span>
        </div>
      ) : isEmpty ? (
        <div className="mt-1 flex justify-between text-[10px]" style={{ color: TERM_PANEL.dim }}>
          <span>{sourceLabel}</span>
          <span>{t("termStats.peak", { value: formatCompactCount(peakTokens) })}</span>
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
  const { t } = useI18n();
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
          <span className="truncate" style={{ color: TERM_PANEL.fg }} title={item.name}>
            {item.name}
          </span>
          <span className="shrink-0 font-bold" style={{ color }}>
            {formatCompactCount(item.count)}
          </span>
        </div>
      ))}
      {restCount > 0 && (
        <div className="text-[10px]" style={{ color: TERM_PANEL.dim }}>
          +{restCount} {t("common.more")}
        </div>
      )}
    </div>
  );
}

export function ToolsCard({ session }: { session: HistorySessionDetail | null }) {
  const { t } = useI18n();
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
      iconColor={TERM_PANEL.blue}
      title={t("termStats.tools")}
      headerRight={
        toolCalls > 0 ? (
          <HeaderPill color={TERM_PANEL.blue}>{t("termStats.callCount", { count: formatCompactCount(toolCalls) })}</HeaderPill>
        ) : isEmpty ? (
          <HeaderPill color={TERM_PANEL.blue}>{t("termStats.zeroCalls")}</HeaderPill>
        ) : undefined
      }
    >
      {mcpCalls.length === 0 && skillCalls.length === 0 && builtinCalls.length === 0 ? (
        <div className="text-[11px]" style={{ color: TERM_PANEL.dim }}>
          {t("termStats.noToolCalls")}
        </div>
      ) : (
        <>
          {builtinCalls.length > 0 && (
            <ToolCountList label={t("termStats.builtinTools")} color={TERM_PANEL.green} items={builtinCalls} />
          )}
          {mcpCalls.length > 0 && <ToolCountList label="MCP" color={TERM_PANEL.cyan} items={mcpCalls} />}
          {skillCalls.length > 0 && (
            <ToolCountList label={t("termStats.skillCommand")} color={TERM_PANEL.magenta} items={skillCalls} />
          )}
        </>
      )}
    </StatCard>
  );
}

export interface LatestChangesCardData {
  fileCount: number;
  additions: number;
  deletions: number;
  files: HistoryFileChangeSummary[];
}

export function LatestChangesCard({
  summary,
  onOpenDiff,
}: {
  summary: LatestChangesCardData | null;
  onOpenDiff: (fileChange: HistoryFileChangeSummary) => void;
}) {
  const { t } = useI18n();
  return (
    <StatCard
      icon={<FileCode2 size={13} />}
      iconColor={TERM_PANEL.cyan}
      title={t("termStats.latestChanges")}
      headerRight={
        summary ? (
          <HeaderPill color={TERM_PANEL.cyan}>
            {t("termStats.latestChangesFiles", { count: summary.fileCount })}
          </HeaderPill>
        ) : undefined
      }
    >
      {!summary ? (
        <div className="text-[11px]" style={{ color: TERM_PANEL.dim }}>
          {t("termStats.latestChangesEmpty")}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <div
              className="flex min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5"
              style={{ backgroundColor: TERM_PANEL.cardInner, border: `1px solid ${TERM_PANEL.border}` }}
            >
              <span className="flex items-center gap-1.5 text-[10px]" style={{ color: TERM_PANEL.green }}>
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: TERM_PANEL.green }} />
                <span className="truncate">{t("termStats.latestChangesAdded")}</span>
              </span>
              <span className="truncate text-[12px] font-bold" style={{ color: TERM_PANEL.green }} title={`+${summary.additions}`}>
                +{formatCompactCount(summary.additions)}
              </span>
            </div>
            <div
              className="flex min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5"
              style={{ backgroundColor: TERM_PANEL.cardInner, border: `1px solid ${TERM_PANEL.border}` }}
            >
              <span className="flex items-center gap-1.5 text-[10px]" style={{ color: TERM_PANEL.red }}>
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: TERM_PANEL.red }} />
                <span className="truncate">{t("termStats.latestChangesDeleted")}</span>
              </span>
              <span className="truncate text-[12px] font-bold" style={{ color: TERM_PANEL.red }} title={`-${summary.deletions}`}>
                -{formatCompactCount(summary.deletions)}
              </span>
            </div>
          </div>
          <div className="mt-2 space-y-1.5">
            {summary.files.slice(0, 4).map((fileChange) => (
              <div
                key={fileChange.file_path}
                className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5"
                style={{ backgroundColor: TERM_PANEL.cardInner, border: `1px solid ${TERM_PANEL.border}` }}
              >
                <div className="min-w-0">
                  <div
                    className="truncate text-[11px] font-semibold"
                    style={{ color: TERM_PANEL.fg }}
                    title={fileChange.file_path}
                  >
                    {fileChange.file_path}
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] font-medium">
                    <span style={{ color: TERM_PANEL.green }}>+{formatCompactCount(fileChange.additions)}</span>
                    <span style={{ color: TERM_PANEL.dim }}>/</span>
                    <span style={{ color: TERM_PANEL.red }}>-{formatCompactCount(fileChange.deletions)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenDiff(fileChange)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
                  style={{ color: TERM_PANEL.cyan, backgroundColor: "color-mix(in srgb, var(--term-panel-cyan, #5AC8E0) 12%, transparent)" }}
                  title={t("termStats.latestChangesViewDiff")}
                  aria-label={t("termStats.latestChangesViewDiff")}
                >
                  <GitCompareArrows size={14} strokeWidth={1.8} />
                </button>
              </div>
            ))}
          </div>
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
  const { t } = useI18n();
  return (
    <StatCard
      icon={<CalendarClock size={13} />}
      iconColor={TERM_PANEL.green}
      title={t("termStats.todayUsage")}
      headerRight={
        stats && stats.sessions > 0 ? <HeaderPill>{t("termStats.sessionCount", { count: stats.sessions })}</HeaderPill> : undefined
      }
    >
      {loading && !stats ? (
        <div className="text-[11px]" style={{ color: TERM_PANEL.dim }}>
          {t("common.loading")}
        </div>
      ) : stats && stats.sessions > 0 ? (
        <div className="grid grid-cols-2 gap-1.5">
          <StatChip
            dotColor={TERM_PANEL.yellow}
            label="Token"
            value={formatCompactCount(stats.totalTokens)}
            valueColor={TERM_PANEL.yellow}
          />
          <StatChip
            dotColor={TERM_PANEL.green}
            label={t("termStats.cost")}
            value={formatCost(stats.totalCostUsd)}
            valueColor={TERM_PANEL.green}
          />
        </div>
      ) : (
        <div className="text-[11px]" style={{ color: TERM_PANEL.dim }}>
          {t("termStats.todayNoSessions")}
        </div>
      )}
    </StatCard>
  );
}
