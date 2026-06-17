import { useEffect, useId, useRef, useState } from "react";
import type { HistorySessionDetail } from "../../lib/types";
import { calculateCost, inferDominantModel } from "../../lib/modelPricing";

// 终端监控面板配色（btop / 系统监控风格，深色卡片 + 绿色点缀）
export const TERM = {
  bg: "#0A0A0A",
  card: "#121212",
  cardInner: "#181818",
  border: "#2E2E2E",
  fg: "#ECECEC",
  dim: "#9CA0A6",
  green: "#3DD68C",
  yellow: "#E5C453",
  red: "#F25E5E",
  magenta: "#C77DBB",
  cyan: "#5AC8E0",
  blue: "#5B8DEF",
  track: "#222222",
};

// 来源徽章配色：claude 黄 / codex 青
export const SOURCE_COLORS: Record<string, string> = {
  claude: TERM.yellow,
  codex: TERM.cyan,
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
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
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
  title,
  headerRight,
  children,
}: {
  icon: React.ReactNode;
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
            style={{ backgroundColor: `${TERM.green}1A`, color: TERM.green }}
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
      style={{ borderColor: `${color}55`, color, backgroundColor: `${color}14` }}
    >
      {children}
    </span>
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
          stroke={TERM.track}
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

export function Sparkline({
  points,
  color = TERM.green,
  height = 36,
}: {
  points: number[];
  color?: string;
  height?: number;
}) {
  const gradientId = useId();
  if (points.length < 2) {
    return (
      <div
        className="flex items-center justify-center rounded-md text-[10px]"
        style={{ height, color: TERM.dim, backgroundColor: TERM.cardInner }}
      >
        暂无趋势数据
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

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full" style={{ height }}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={2.4} fill={color} className="animate-pulse" />
    </svg>
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
      style={{ height, backgroundColor: TERM.track }}
    >
      {parts.map((part, index) => (
        <div
          key={index}
          className="h-full transition-all duration-700 ease-out"
          style={{ width: `${(Math.max(0, part.value) / total) * 100}%`, backgroundColor: part.color }}
          title={part.label ? `${part.label} ${formatCount(part.value)}` : undefined}
        />
      ))}
    </div>
  );
}

export function ProgressBar({ ratio, color, height = 6 }: { ratio: number; color: string; height?: number }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div className="w-full overflow-hidden rounded-full" style={{ height, backgroundColor: TERM.track }}>
      <div
        className="h-full rounded-full transition-all duration-700 ease-out"
        style={{ width: `${clamped * 100}%`, backgroundColor: color }}
      />
    </div>
  );
}

export function LiveDot({ color = TERM.green }: { color?: string }) {
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
    <div className="flex h-full items-center justify-center p-4 text-[12px]" style={{ color: TERM.dim }}>
      <span style={{ color: TERM.green }}>❯&nbsp;</span>
      {text}
      <span className="animate-pulse" style={{ color: TERM.fg }}>
        ▊
      </span>
    </div>
  );
}
