import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { HistorySessionDetail } from "../../lib/types";
import { calculateCost, inferDominantModel } from "../../lib/modelPricing";
import { VendorIcon, inferVendor } from "../VendorIcon";
import { translateCurrent } from "../../lib/i18n";
import type { TerminalSidePanelSkin } from "../../stores/settingsStore";

// 终端侧边面板语义配色。具体值由终端主题或侧边栏皮肤写入 CSS 变量。
export const TERM = {
  bg: "var(--term-panel-bg, #0A0A0A)",
  card: "var(--term-panel-card, #121212)",
  cardInner: "var(--term-panel-card-inner, #181818)",
  border: "var(--term-panel-border, #2E2E2E)",
  fg: "var(--term-panel-fg, #ECECEC)",
  dim: "var(--term-panel-dim, #9CA0A6)",
  green: "var(--term-panel-green, #3DD68C)",
  yellow: "var(--term-panel-yellow, #E5C453)",
  red: "var(--term-panel-red, #F25E5E)",
  magenta: "var(--term-panel-magenta, #C77DBB)",
  cyan: "var(--term-panel-cyan, #5AC8E0)",
  blue: "var(--term-panel-blue, #5B8DEF)",
  track: "var(--term-panel-track, #222222)",
};

export const TERM_PANEL = TERM;

export function panelColorTint(color: string, amount: number, base = "transparent"): string {
  const clamped = Math.max(0, Math.min(100, amount));
  return `color-mix(in srgb, ${color} ${clamped}%, ${base})`;
}

const SIDE_PANEL_SKIN_STYLES: Record<Exclude<TerminalSidePanelSkin, "terminal">, Record<string, string>> = {
  "classic-terminal": {
    "--term-panel-bg": "#0A0A0A",
    "--term-panel-card": "#121212",
    "--term-panel-card-inner": "#181818",
    "--term-panel-border": "#2E2E2E",
    "--term-panel-fg": "#ECECEC",
    "--term-panel-dim": "#9CA0A6",
    "--term-panel-green": "#3DD68C",
    "--term-panel-yellow": "#E5C453",
    "--term-panel-red": "#F25E5E",
    "--term-panel-magenta": "#C77DBB",
    "--term-panel-cyan": "#5AC8E0",
    "--term-panel-blue": "#5B8DEF",
    "--term-panel-track": "#222222",
  },
  "warm-paper": {
    "--term-panel-bg": "#fbf4e8",
    "--term-panel-card": "#fffaf0",
    "--term-panel-card-inner": "#f4ead7",
    "--term-panel-border": "#dec7a6",
    "--term-panel-fg": "#2e2418",
    "--term-panel-dim": "#77634a",
    "--term-panel-green": "#4f8a55",
    "--term-panel-yellow": "#b9811f",
    "--term-panel-red": "#c15442",
    "--term-panel-magenta": "#a65d7a",
    "--term-panel-cyan": "#2f8797",
    "--term-panel-blue": "#3f6ea8",
    "--term-panel-track": "#eadbc3",
  },
  sunrise: {
    "--term-panel-bg": "#fff2e4",
    "--term-panel-card": "#fff8ec",
    "--term-panel-card-inner": "#ffe8d1",
    "--term-panel-border": "#f2bf8a",
    "--term-panel-fg": "#331d12",
    "--term-panel-dim": "#855d42",
    "--term-panel-green": "#5d8f48",
    "--term-panel-yellow": "#c77a1d",
    "--term-panel-red": "#d15b45",
    "--term-panel-magenta": "#b46a86",
    "--term-panel-cyan": "#2e8c95",
    "--term-panel-blue": "#4d73b8",
    "--term-panel-track": "#f7d9bd",
  },
  linen: {
    "--term-panel-bg": "#f8efe1",
    "--term-panel-card": "#fffaf1",
    "--term-panel-card-inner": "#efe2cd",
    "--term-panel-border": "#d4bea0",
    "--term-panel-fg": "#2b251d",
    "--term-panel-dim": "#726555",
    "--term-panel-green": "#5f8358",
    "--term-panel-yellow": "#a97929",
    "--term-panel-red": "#b65a4a",
    "--term-panel-magenta": "#98677d",
    "--term-panel-cyan": "#4f8790",
    "--term-panel-blue": "#576f9e",
    "--term-panel-track": "#e7d7bd",
  },
  latte: {
    "--term-panel-bg": "#f6eadc",
    "--term-panel-card": "#fff7ee",
    "--term-panel-card-inner": "#ead8c5",
    "--term-panel-border": "#c9ab8e",
    "--term-panel-fg": "#30251c",
    "--term-panel-dim": "#7b6654",
    "--term-panel-green": "#678955",
    "--term-panel-yellow": "#a66f2a",
    "--term-panel-red": "#b45b4c",
    "--term-panel-magenta": "#956075",
    "--term-panel-cyan": "#4d8388",
    "--term-panel-blue": "#596f9c",
    "--term-panel-track": "#dfc9b5",
  },
};

export function getTerminalSidePanelSkinStyle(skin: TerminalSidePanelSkin): CSSProperties {
  if (skin === "terminal") return {};
  return SIDE_PANEL_SKIN_STYLES[skin] as CSSProperties;
}

// 来源徽章配色：claude 黄 / codex 青
export const SOURCE_COLORS: Record<string, string> = {
  claude: TERM_PANEL.yellow,
  codex: TERM_PANEL.cyan,
};

export function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Math.round(value)));
}

export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatCount(value);
}

export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function truncatePath(path: string, maxSegments = 3): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  if (segments.length <= maxSegments) return segments.join("/");
  return `…/${segments.slice(-maxSegments).join("/")}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatRelativeTime(timestampMs: number): string {
  const diff = Date.now() - timestampMs;
  if (diff < 60_000) return translateCurrent("termStats.justNow");
  if (diff < 3_600_000) return translateCurrent("termStats.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return translateCurrent("termStats.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  return translateCurrent("termStats.daysAgo", { count: Math.floor(diff / 86_400_000) });
}

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  estimatedCost: number;
  dominantModel: string | null;
}

export function calculateTokenStats(session: HistorySessionDetail | null): TokenStats {
  if (!session) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      dominantModel: null,
    };
  }

  // 优先使用后端扫描的会话级用量（已做重复行去重与 Codex 差分修正，覆盖 Codex 等
  // 消息行不带 usage 的来源）；后端无数据时回退为前端逐消息求和。
  const usage = session.usage;
  let inputTokens = usage?.input_tokens ?? 0;
  let outputTokens = usage?.output_tokens ?? 0;
  let cacheCreationTokens = usage?.cache_creation_tokens ?? 0;
  let cacheReadTokens = usage?.cache_read_tokens ?? 0;
  let dominantModel = usage?.dominant_model ?? null;

  if (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0) {
    for (const msg of session.messages) {
      inputTokens += msg.input_tokens ?? 0;
      outputTokens += msg.output_tokens ?? 0;
      cacheCreationTokens += msg.cache_creation_tokens ?? 0;
      cacheReadTokens += msg.cache_read_tokens ?? 0;
    }
  }
  if (!dominantModel) {
    dominantModel = inferDominantModel(session.messages);
  }

  const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
  const estimatedCost =
    usage && usage.total_cost_usd > 0
      ? usage.total_cost_usd
      : calculateCost(inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, dominantModel);

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
    estimatedCost,
    dominantModel,
  };
}

// 数字滚动动画：值变化时在 duration 内缓动过渡
export function useCountUp(target: number, duration = 700): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);

  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (target - from) * eased;
      setValue(current);
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      fromRef.current = target;
      cancelAnimationFrame(raf);
    };
  }, [target, duration]);

  return value;
}

export function StatCard({
  icon,
  iconColor = TERM_PANEL.green,
  title,
  headerRight,
  children,
}: {
  icon: React.ReactNode;
  iconColor?: string;
  title: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-xl border p-3 transition-colors duration-300"
      style={{ backgroundColor: TERM.card, borderColor: TERM.border }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
            style={{ backgroundColor: panelColorTint(iconColor, 10), color: iconColor }}
          >
            {icon}
          </span>
          <span className="truncate text-[12px] font-bold" style={{ color: TERM.fg }}>
            {title}
          </span>
        </div>
        {headerRight}
      </div>
      {children}
    </section>
  );
}

export function HeaderPill({ children, color = TERM.green }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold"
      style={{ borderColor: panelColorTint(color, 34), color, backgroundColor: panelColorTint(color, 8) }}
    >
      {children}
    </span>
  );
}

// 来源徽章（claude / codex）：在原配色胶囊内前置品牌图标
export function SourcePill({ source }: { source: string }) {
  const vendor = inferVendor(source);
  return (
    <HeaderPill color={SOURCE_COLORS[source] ?? TERM.cyan}>
      <span className="inline-flex items-center gap-1">
        {vendor && <VendorIcon vendor={vendor} size={11} />}
        {source}
      </span>
    </HeaderPill>
  );
}

export function Row({
  label,
  value,
  color = TERM.fg,
  title,
  icon,
  onDoubleClick,
}: {
  label: string;
  value: string;
  color?: string;
  title?: string;
  icon?: React.ReactNode;
  onDoubleClick?: () => void;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px] leading-5">
      <span className="flex shrink-0 items-center gap-1" style={{ color: TERM.dim }}>
        {icon}
        {label}
      </span>
      <span
        className={`truncate text-right ${onDoubleClick ? "cursor-pointer hover:underline" : ""}`}
        style={{ color }}
        title={title ?? value}
        onDoubleClick={onDoubleClick}
      >
        {value}
      </span>
    </div>
  );
}

export function StatChip({
  dotColor,
  label,
  value,
  valueColor,
}: {
  dotColor: string;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5"
      style={{ backgroundColor: TERM.cardInner, border: `1px solid ${TERM.border}` }}
    >
      <span className="flex items-center gap-1.5 text-[10px]" style={{ color: TERM.dim }}>
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />
        <span className="truncate">{label}</span>
      </span>
      <span className="truncate text-[12px] font-bold" style={{ color: valueColor ?? TERM.fg }} title={value}>
        {value}
      </span>
    </div>
  );
}

export interface DonutSegment {
  value: number;
  color: string;
}

export function Donut({
  segments,
  size = 68,
  thickness = 9,
  children,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  children?: React.ReactNode;
}) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = Math.max(
    1,
    segments.reduce((sum, seg) => sum + Math.max(0, seg.value), 0)
  );
  let offsetFraction = 0;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={TERM_PANEL.track}
          strokeWidth={thickness}
        />
        {segments.map((seg, index) => {
          const fraction = Math.max(0, seg.value) / total;
          const dash = fraction * circumference;
          const element = (
            <circle
              key={index}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offsetFraction * circumference}
              className="transition-all duration-700 ease-out"
            />
          );
          offsetFraction += fraction;
          return element;
        })}
      </svg>
      {children && (
        <div className="absolute inset-0 flex items-center justify-center">{children}</div>
      )}
    </div>
  );
}

export interface SparkPoint {
  total: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  model?: string | null;
  color?: string;
}

// 折线悬浮提示：展示该数据点的 token 明细与序号，配色对齐"Token 用量"卡片
function SparkTooltip({
  index,
  count,
  total,
  detail,
}: {
  index: number;
  count: number;
  total: number;
  detail?: SparkPoint;
}) {
  const rows = detail
    ? [
        { label: translateCurrent("termStats.input"), value: detail.input ?? 0, color: TERM_PANEL.green },
        { label: translateCurrent("termStats.output"), value: detail.output ?? 0, color: TERM_PANEL.yellow },
        { label: translateCurrent("termStats.cacheHit"), value: detail.cacheRead ?? 0, color: TERM_PANEL.blue },
        { label: translateCurrent("termStats.cacheWrite"), value: detail.cacheCreation ?? 0, color: TERM_PANEL.magenta },
      ]
    : [];

  return (
    <div
      className="rounded-lg border px-2.5 py-1.5 text-[10px] tabular-nums shadow-lg"
      style={{ backgroundColor: TERM_PANEL.cardInner, borderColor: TERM_PANEL.border, minWidth: 124 }}
    >
      <div className="mb-1 font-semibold" style={{ color: TERM_PANEL.cyan }}>
        {translateCurrent("termStats.tooltipPoint", { index: index + 1, count })}
      </div>
      {detail?.model ? (
        <div className="mb-1 flex items-center justify-between gap-3 leading-4">
          <span style={{ color: TERM_PANEL.dim }}>{translateCurrent("termStats.model")}</span>
          <span
            className="max-w-[128px] truncate font-semibold"
            style={{ color: detail.color ?? TERM_PANEL.cyan }}
            title={detail.model}
          >
            {detail.model}
          </span>
        </div>
      ) : null}
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-3 leading-4">
          <span className="flex items-center gap-1.5" style={{ color: TERM_PANEL.dim }}>
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: r.color }} />
            {r.label}
          </span>
          <span style={{ color: TERM_PANEL.fg }}>{formatCount(r.value)}</span>
        </div>
      ))}
      <div
        className="mt-1 flex items-center justify-between gap-3 border-t pt-1 leading-4"
        style={{ borderColor: TERM_PANEL.border }}
      >
        <span style={{ color: TERM_PANEL.dim }}>{translateCurrent("termStats.total")}</span>
        <span className="font-bold" style={{ color: TERM_PANEL.fg }}>
          {formatCount(total)}
        </span>
      </div>
    </div>
  );
}

export function Sparkline({
  points,
  details,
  color = TERM_PANEL.green,
  height = 36,
}: {
  points: number[];
  details?: SparkPoint[];
  color?: string;
  height?: number;
}) {
  const gradientId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <div
        className="flex items-center justify-center rounded-md text-[10px]"
        style={{ height, color: TERM_PANEL.dim, backgroundColor: TERM_PANEL.cardInner }}
      >
        {translateCurrent("termStats.noTrendData")}
      </div>
    );
  }

  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * 100;
    const y = 92 - ((p - min) / range) * 78;
    return [x, y] as const;
  });
  const linePath = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const areaPath = `${linePath} L100,100 L0,100 Z`;
  const [lastX, lastY] = coords[coords.length - 1];
  const pointColors = points.map((_, index) => details?.[index]?.color ?? color);

  // hover 命中：用容器像素宽换算最近点索引
  const safeIndex =
    hoverIndex !== null && hoverIndex >= 0 && hoverIndex < coords.length ? hoverIndex : -1;
  const active = safeIndex >= 0;
  const [hoverX, hoverY] = active ? coords[safeIndex] : [0, 0];
  const activeColor = active ? pointColors[safeIndex] : pointColors[pointColors.length - 1] ?? color;
  // tooltip 水平防溢出：左/中/右三段对齐
  const align = hoverX < 33 ? "0" : hoverX > 67 ? "-100%" : "-50%";

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHoverIndex(Math.round(ratio * (points.length - 1)));
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      style={{ height }}
      onMouseMove={handleMove}
      onMouseLeave={() => setHoverIndex(null)}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full" style={{ height }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradientId})`} />
        {coords.slice(1).map(([x, y], index) => {
          const [prevX, prevY] = coords[index];
          const segmentColor = pointColors[index + 1] ?? color;
          return (
            <path
              key={index}
              d={`M${prevX},${prevY} L${x},${y}`}
              fill="none"
              stroke={segmentColor}
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}
        {active ? (
          <line
            x1={hoverX}
            y1={0}
            x2={hoverX}
            y2={100}
            stroke={activeColor}
            strokeWidth={1}
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
            opacity={0.45}
          />
        ) : (
          <circle cx={lastX} cy={lastY} r={2.4} fill={activeColor} className="animate-pulse" />
        )}
      </svg>

      {active && (
        <span
          className="pointer-events-none absolute block rounded-full"
          style={{
            left: `${hoverX}%`,
            top: `${(hoverY / 100) * height}px`,
            width: 7,
            height: 7,
            transform: "translate(-50%, -50%)",
            backgroundColor: activeColor,
            boxShadow: `0 0 0 2px ${TERM_PANEL.card}`,
          }}
        />
      )}

      {active && (
        <div
          className="pointer-events-none absolute z-20"
          style={{ left: `${hoverX}%`, bottom: "calc(100% + 6px)", transform: `translateX(${align})` }}
        >
          <SparkTooltip
            index={safeIndex}
            count={points.length}
            total={points[safeIndex]}
            detail={details?.[safeIndex]}
          />
        </div>
      )}
    </div>
  );
}

export interface SegmentedBarPart {
  value: number;
  color: string;
  label?: string;
}

export function SegmentedBar({ parts, height = 6 }: { parts: SegmentedBarPart[]; height?: number }) {
  const total = Math.max(
    1,
    parts.reduce((sum, part) => sum + Math.max(0, part.value), 0)
  );
  return (
    <div
      className="flex w-full overflow-hidden rounded-full"
      style={{ height, backgroundColor: TERM_PANEL.track }}
    >
      {parts.map((part, index) => (
        <div
          key={index}
          className="h-full transition-all duration-700 ease-out"
          style={{
            width: `${(Math.max(0, part.value) / total) * 100}%`,
            minWidth: part.value > 0 ? 2 : 0,
            backgroundColor: part.color,
            boxShadow: index > 0 && part.value > 0
              ? "inset 1px 0 0 color-mix(in srgb, var(--bg-primary) 72%, transparent)"
              : undefined,
          }}
          title={part.label ? `${part.label} ${formatCount(part.value)}` : undefined}
        />
      ))}
    </div>
  );
}

export function ProgressBar({ ratio, color, height = 6 }: { ratio: number; color: string; height?: number }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div className="w-full overflow-hidden rounded-full" style={{ height, backgroundColor: TERM_PANEL.track }}>
      <div
        className="h-full rounded-full transition-all duration-700 ease-out"
        style={{ width: `${clamped * 100}%`, backgroundColor: color }}
      />
    </div>
  );
}

export function LiveDot({ color = TERM_PANEL.green }: { color?: string }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      <span
        className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
        style={{ backgroundColor: color }}
      />
      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
    </span>
  );
}

export function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-[12px]" style={{ color: TERM_PANEL.dim }}>
      <span style={{ color: TERM_PANEL.green }}>❯&nbsp;</span>
      {text}
      <span className="animate-pulse" style={{ color: TERM_PANEL.fg }}>
        ▊
      </span>
    </div>
  );
}
