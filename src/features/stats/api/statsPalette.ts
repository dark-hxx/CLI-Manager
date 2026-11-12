// 用量分析图表共享色板。
// 实时小图继续使用主题语义色；历史/ccusage 分析图使用固定可区分图表色，
// 避免某些主题下 --accent / --success 过近导致多条线和扇区看起来同色。

const mix = (token: string, percent: number, base = "var(--bg-tertiary)") =>
  `color-mix(in srgb, ${token} ${percent}%, ${base})`;

// Token 构成 / 多系列：以主色为基准，辅以系统语义色 + 透明度梯度区分。
export const SERIES_COLORS = {
  input: "var(--accent)",
  output: "var(--success)",
  cacheCreation: "var(--warning)",
  cacheRead: mix("var(--accent)", 52),
} as const;

export const USAGE_SERIES_COLORS = {
  input: "#33B1FF",
  output: "#FF8389",
  cacheCreation: "#F1C21B",
  cacheRead: "#08BDBA",
} as const;

export const USAGE_TREND_COLORS = {
  total: "#78A9FF",
  ...USAGE_SERIES_COLORS,
} as const;

export const HISTORY_SERIES_COLORS = USAGE_SERIES_COLORS;
export const HISTORY_TREND_COLORS = USAGE_TREND_COLORS;

export const HISTORY_HEATMAP_COLORS = {
  empty: "var(--bg-tertiary)",
  level1: "#003A6D",
  level2: "#0072C3",
  level3: "#33B1FF",
  level4: "#78A9FF",
} as const;

// 主趋势线、排行主条等使用冷蓝；峰值/选中用少量暖色点缀。
export const ACCENT = "#33B1FF";
export const PEAK = "#F1C21B";

// 费用等辅助量：保留暖色识别度，避免浅色主题下透明混色看成灰色。
export const COST_COLOR = "#FF832B";

export const RECHARTS_AXIS_CURSOR = {
  stroke: "color-mix(in srgb, #33B1FF 36%, transparent)",
  strokeWidth: 1,
} as const;

export const RECHARTS_BAR_CURSOR = {
  fill: "color-mix(in srgb, #33B1FF 10%, transparent)",
} as const;

export const ECHARTS_AXIS_SHADOW = "color-mix(in srgb, #33B1FF 10%, transparent)";
export const ECHARTS_AXIS_LINE = "color-mix(in srgb, #33B1FF 36%, transparent)";

export const RECHARTS_TOOLTIP_WRAPPER_STYLE = {
  outline: "none",
} as const;

export const RECHARTS_TOOLTIP_LABEL_STYLE = {
  color: "var(--text-primary)",
  fontWeight: 600,
} as const;

export const RECHARTS_TOOLTIP_ITEM_STYLE = {
  color: "var(--text-secondary)",
} as const;

// 轻量 tooltip：贴合当前主题表面色，替代原先硬编码的深色玻璃。
export const CHART_TOOLTIP = {
  backgroundColor: "var(--bg-secondary)",
  borderColor: "var(--border)",
  borderWidth: 1,
  padding: [8, 12] as [number, number],
  textStyle: { color: "var(--text-primary)", fontSize: 12 },
  extraCssText: "border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,0.18);color:var(--text-primary);",
};

// 历史用量分析（StatsPanel）专用：引用 stats-panel.css 中按亮/暗主题切换的 Apple 系统色，
// 只在 .ui-stats-panel 作用域内有效；实时统计等其它面板继续使用上面的固定色板。
export const STATS_COLORS = {
  total: "var(--stats-blue)",
  input: "var(--stats-teal)",
  output: "var(--stats-indigo)",
  cacheCreation: "var(--stats-orange)",
  cacheRead: "var(--stats-green)",
  cost: "var(--stats-pink)",
  peak: "var(--stats-orange)",
  accent: "var(--stats-blue)",
} as const;

// 排行/来源等分类序列：色相间隔拉开，前几项即可互相区分。
export const STATS_CATEGORICAL = [
  "var(--stats-blue)",
  "var(--stats-purple)",
  "var(--stats-teal)",
  "var(--stats-orange)",
  "var(--stats-green)",
  "var(--stats-pink)",
  "var(--stats-indigo)",
  "var(--stats-yellow)",
] as const;

export const STATS_AXIS_TICK = {
  fill: "var(--stats-axis)",
  fontSize: 11,
} as const;

export const STATS_GRID_STROKE = "var(--stats-grid)";

export const STATS_AXIS_CURSOR = {
  stroke: "var(--stats-grid)",
  strokeWidth: 1,
} as const;

export const STATS_BAR_CURSOR = {
  fill: "var(--stats-fill)",
  radius: 6,
} as const;

// 热力等级：同一色相按透明度递进，自动适配卡片底色。
export function statsHeatColor(level: number): string {
  if (level <= 0) return "var(--stats-fill-strong)";
  const alpha = [0, 28, 50, 74, 100][Math.min(4, level)];
  return `color-mix(in srgb, var(--stats-blue) ${alpha}%, transparent)`;
}
