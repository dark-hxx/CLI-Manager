import { Coins, Cpu, Database, Info, Layers3, TrendingUp, Wrench } from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HistorySessionDetail } from "../../lib/types";
import { useI18n } from "../../lib/i18n";
import {
  calculateTokenStats,
  Donut,
  formatCompactCount,
  formatCost,
  formatDuration,
  ProgressBar,
  SegmentedBar,
  TERM,
  truncatePath,
} from "../stats/termStatsUi";
import { resolveContextLimit } from "../../lib/modelPricing";
import { HISTORY_SERIES_COLORS, HISTORY_TREND_COLORS, PEAK, RECHARTS_AXIS_CURSOR } from "../stats/statsPalette";

const RECHARTS_TOOLTIP_STYLE = {
  backgroundColor: "var(--bg-secondary)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  boxShadow: "0 8px 28px rgba(0,0,0,0.18)",
  color: "var(--text-primary)",
  fontSize: 12,
} as const;

const RECHARTS_AXIS_STYLE = {
  fill: "var(--text-muted)",
  fontSize: 11,
} as const;

interface SessionContextViewProps {
  session: HistorySessionDetail | null;
}

function sumToolCounts(items: { count: number }[] | undefined): number {
  return items?.reduce((sum, item) => sum + item.count, 0) ?? 0;
}

function ContextMetric({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <span className="ui-session-context-metric" title={title ?? `${label} ${value}`}>
      <small>{label}</small>
      <b>{value}</b>
    </span>
  );
}

export function SessionContextView({ session }: SessionContextViewProps) {
  const { t } = useI18n();
  const stats = calculateTokenStats(session);
  const usage = session?.usage;
  const totalToolCalls = usage?.tool_call_count ?? 0;
  const mcpCallCount = sumToolCounts(usage?.mcp_calls);
  const skillCallCount = sumToolCounts(usage?.skill_calls);
  const builtinCallCount = sumToolCounts(usage?.builtin_calls);
  const sessionDuration = session ? formatDuration(session.updated_at - session.created_at) : "—";
  const sessionSource = session?.source ?? "—";
  const sessionProject = session?.project_key || "—";
  const sessionBranch = session?.branch?.trim() || "—";
  const sessionLocation = session?.cwd?.trim() || session?.file_path || "—";
  const sessionLocationLabel = sessionLocation === "—" ? "—" : truncatePath(sessionLocation, 3);
  const contextLimit = resolveContextLimit(stats.dominantModel, session?.usage?.context_window);
  const lastContextTokens = session?.usage?.last_context_tokens ?? null;
  const usageRatio = contextLimit && lastContextTokens !== null ? lastContextTokens / contextLimit : null;
  const trend = session?.usage?.token_trend ?? [];
  const trendPoints = trend
    .map((point) => ({
      totalTokens: point.total_tokens,
      inputTokens: point.input_tokens,
      outputTokens: point.output_tokens,
      cacheReadTokens: point.cache_read_tokens,
      cacheCreationTokens: point.cache_creation_tokens,
    }))
    .filter((point) => point.totalTokens > 0);
  const trendChartData = trendPoints.map((point, index) => ({
    ...point,
    label: `#${index + 1}`,
  }));
  const trendValues = trendPoints.map((point) => point.totalTokens);
  const peakTokens = trendValues.length > 0 ? Math.max(...trendValues) : 0;
  const averageTokens = trendValues.length > 0 ? trendValues.reduce((sum, value) => sum + value, 0) / trendValues.length : 0;
  const remaining = contextLimit && lastContextTokens !== null ? Math.max(0, contextLimit - lastContextTokens) : null;
  const contextColor = usageRatio === null ? TERM.dim : usageRatio >= 0.8 ? TERM.red : usageRatio >= 0.5 ? TERM.yellow : TERM.green;
  const trendChartLabel = `${t("history.context.requestTokenTrend")} · ${t("history.context.ioCacheTrend")}`;
  const tokenSegments = [
    { label: t("termStats.input"), value: stats.inputTokens, color: HISTORY_SERIES_COLORS.input },
    { label: t("termStats.output"), value: stats.outputTokens, color: HISTORY_SERIES_COLORS.output },
    { label: t("termStats.cacheHit"), value: stats.cacheReadTokens, color: HISTORY_SERIES_COLORS.cacheRead },
    { label: t("termStats.cacheWrite"), value: stats.cacheCreationTokens, color: HISTORY_SERIES_COLORS.cacheCreation },
  ];

  if (!session) return <div className="ui-session-process-empty">{t("history.context.selectSession")}</div>;

  return (
    <div className="ui-session-context-view">
      <section className="ui-session-process-card">
        <div className="ui-session-process-card-title">
          <Cpu size={14} />
          {t("history.context.window")}
        </div>
        <div className="ui-session-context-main">
          <span>{lastContextTokens !== null ? formatCompactCount(lastContextTokens) : "—"}</span>
          <small>/ {contextLimit ? formatCompactCount(contextLimit) : t("history.context.unknownLimit")}</small>
        </div>
        {usageRatio !== null ? (
          <>
            <ProgressBar ratio={usageRatio} color={contextColor} />
            <div className="ui-session-context-subline">
              <span>{t("history.context.usedPercent", { percent: (usageRatio * 100).toFixed(1) })}</span>
              <span>{t("history.context.remaining", { value: remaining !== null ? formatCompactCount(remaining) : "—" })}</span>
            </div>
          </>
        ) : (
          <div className="ui-session-process-empty compact">{t("history.context.noWindowData")}</div>
        )}
      </section>

      <section className="ui-session-process-card">
        <div className="ui-session-process-card-title">
          <Layers3 size={14} />
          {t("history.context.tokenComposition")}
        </div>
        <div className="ui-session-context-token-card">
          <Donut
            size={74}
            segments={tokenSegments.map(({ value, color }) => ({ value, color }))}
          >
            <span className="ui-session-context-donut-label">{formatCompactCount(stats.totalTokens)}</span>
          </Donut>
          <div className="ui-session-process-metrics">
            <ContextMetric label={t("termStats.input")} value={formatCompactCount(stats.inputTokens)} />
            <ContextMetric label={t("termStats.output")} value={formatCompactCount(stats.outputTokens)} />
            <ContextMetric label={t("termStats.cacheHit")} value={formatCompactCount(stats.cacheReadTokens)} />
            <ContextMetric label={t("termStats.cacheWrite")} value={formatCompactCount(stats.cacheCreationTokens)} />
          </div>
        </div>
      </section>

      <section className="ui-session-process-card">
        <div className="ui-session-process-card-title">
          <Database size={14} />
          {t("history.context.requestStats")}
        </div>
        <div className="ui-session-process-metrics">
          <ContextMetric label={t("history.context.trendPoints")} value={String(trendPoints.length)} />
          <ContextMetric label={t("history.context.peak")} value={formatCompactCount(peakTokens)} />
          <ContextMetric label={t("history.context.average")} value={formatCompactCount(averageTokens)} />
          <ContextMetric label={t("termStats.model")} value={stats.dominantModel ?? "—"} />
        </div>
      </section>

      <section className="ui-session-process-card">
        <div className="ui-session-process-card-title">
          <Coins size={14} />
          {t("history.context.costAndMessages")}
        </div>
        <div className="ui-session-process-metrics">
          <ContextMetric label={t("termStats.estimatedCost")} value={formatCost(stats.estimatedCost)} />
          <ContextMetric label={t("termStats.messageCount")} value={String(session.messages.length)} />
          <ContextMetric label={t("termStats.duration")} value={sessionDuration} />
          <ContextMetric label={`${t("termStats.total")} Token`} value={formatCompactCount(stats.totalTokens)} />
        </div>
      </section>

      <section className="ui-session-process-card">
        <div className="ui-session-process-card-title">
          <Wrench size={14} />
          {t("history.context.toolCalls")}
        </div>
        <div className="ui-session-process-metrics">
          <ContextMetric label={t("termStats.tools")} value={formatCompactCount(totalToolCalls)} />
          <ContextMetric label="MCP" value={formatCompactCount(mcpCallCount)} />
          <ContextMetric label={t("history.tools.skillCommand")} value={formatCompactCount(skillCallCount)} />
          <ContextMetric label={t("history.tools.builtin")} value={formatCompactCount(builtinCallCount)} />
        </div>
      </section>

      <section className="ui-session-process-card">
        <div className="ui-session-process-card-title">
          <Info size={14} />
          {t("history.context.sessionInfo")}
        </div>
        <div className="ui-session-process-metrics">
          <ContextMetric label={t("history.context.source")} value={sessionSource} />
          <ContextMetric label={t("termStats.project")} value={sessionProject} title={sessionProject} />
          <ContextMetric label={t("termStats.branch")} value={sessionBranch} title={sessionBranch} />
          <ContextMetric label={t("termStats.path")} value={sessionLocationLabel} title={sessionLocation} />
        </div>
      </section>

      <section className="ui-session-process-card wide">
        <div className="ui-session-process-card-title">
          <TrendingUp size={14} />
          {trendChartLabel}
        </div>
        {trendChartData.length >= 2 ? (
          <div className="h-[240px] min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trendChartData} margin={{ top: 10, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeOpacity={0.42} vertical={false} />
                <XAxis dataKey="label" tick={RECHARTS_AXIS_STYLE} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
                <YAxis tick={RECHARTS_AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={(value) => formatCompactCount(Number(value))} allowDecimals={false} width={48} />
                <Tooltip
                  cursor={RECHARTS_AXIS_CURSOR}
                  contentStyle={RECHARTS_TOOLTIP_STYLE}
                  formatter={(value, name) => [`${formatCompactCount(Number(value))} Token`, String(name)]}
                />
                <Legend wrapperStyle={{ color: "var(--text-secondary)", fontSize: 11 }} />
                <Area
                  type="monotone"
                  dataKey="totalTokens"
                  name={t("termStats.total")}
                  stroke={HISTORY_TREND_COLORS.total}
                  fill={HISTORY_TREND_COLORS.total}
                  fillOpacity={0.14}
                  strokeWidth={2.4}
                  dot={{ r: 2.3 }}
                  activeDot={{ r: 5, fill: PEAK }}
                />
                <Line type="monotone" dataKey="inputTokens" name={t("termStats.input")} stroke={HISTORY_TREND_COLORS.input} strokeWidth={1.8} dot={false} />
                <Line type="monotone" dataKey="outputTokens" name={t("termStats.output")} stroke={HISTORY_TREND_COLORS.output} strokeWidth={1.8} dot={false} />
                <Line type="monotone" dataKey="cacheReadTokens" name={t("termStats.cacheHit")} stroke={HISTORY_TREND_COLORS.cacheRead} strokeWidth={1.8} dot={false} />
                <Line type="monotone" dataKey="cacheCreationTokens" name={t("termStats.cacheWrite")} stroke={HISTORY_TREND_COLORS.cacheCreation} strokeWidth={1.8} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="ui-session-process-empty compact">{t("history.context.noTrendPoints")}</div>
        )}
      </section>

      <section className="ui-session-process-card wide">
        <div className="ui-session-process-card-title">
          <Layers3 size={14} />
          {t("history.context.currentTokenDistribution")}
        </div>
        <SegmentedBar
          height={10}
          parts={tokenSegments}
        />
        <div className="ui-session-context-legend gap-3">
          {tokenSegments.map((item) => (
            <span
              key={item.label}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium"
              style={{ color: item.color }}
              title={`${item.label} ${formatCompactCount(item.value)}`}
            >
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: item.color, boxShadow: "0 0 0 1px color-mix(in srgb, var(--bg-primary) 70%, transparent)" }}
              />
              <span>{item.label}</span>
              <b>{formatCompactCount(item.value)}</b>
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
