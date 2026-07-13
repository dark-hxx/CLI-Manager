import { Fragment, type CSSProperties, type ReactNode, useCallback, useId, useMemo, useState } from "react";
import {
  Activity,
  AppWindow,
  ChevronDown,
  Copy,
  Cpu,
  Download,
  Gauge,
  HardDrive,
  ListOrdered,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  Upload,
} from "lucide-react";
import { useI18n } from "../../lib/i18n";
import {
  useSystemResources,
  type SystemResourceSnapshot,
  type SystemResourceSnapshotOptions,
} from "../../hooks/useSystemResources";
import {
  SYSTEM_RESOURCE_CARD_KEYS,
  useSettingsStore,
  type SystemResourceCardKey,
} from "../../stores/settingsStore";
import {
  Donut,
  EmptyHint,
  TERM_PANEL,
  panelColorTint,
} from "../stats/termStatsUi";

interface SystemResourcesPanelProps {
  open: boolean;
  visible?: boolean;
  embedded?: boolean;
}

const PANEL_ACCENT = TERM_PANEL.green;
const PANEL_SOFT_FG = `color-mix(in srgb, ${TERM_PANEL.fg} 74%, ${TERM_PANEL.dim})`;
const NETWORK_UPLOAD_COLOR = `color-mix(in srgb, ${TERM_PANEL.green} 84%, ${TERM_PANEL.fg})`;
const NETWORK_DOWNLOAD_COLOR = `color-mix(in srgb, ${TERM_PANEL.blue} 82%, ${TERM_PANEL.cyan})`;
const DISK_READ_COLOR = `color-mix(in srgb, ${TERM_PANEL.green} 84%, ${TERM_PANEL.fg})`;
const DISK_WRITE_COLOR = `color-mix(in srgb, ${TERM_PANEL.blue} 82%, ${TERM_PANEL.cyan})`;
const MODULE_TITLE_COLOR = TERM_PANEL.green;
const SYSTEM_RESOURCES_RUNTIME_CACHE_KEY = "system-resources-panel";

const PANEL_SCROLLBAR_STYLE = {
  "--ui-scrollbar-thumb": TERM_PANEL.border,
  "--ui-scrollbar-track": TERM_PANEL.bg,
} as CSSProperties;

const CARD_STYLE = {
  background: `linear-gradient(145deg, ${panelColorTint(TERM_PANEL.fg, 4, TERM_PANEL.card)} 0%, ${TERM_PANEL.card} 58%, ${panelColorTint(PANEL_ACCENT, 2, TERM_PANEL.bg)} 100%)`,
  borderColor: TERM_PANEL.border,
  boxShadow: `inset 0 1px 0 ${panelColorTint(TERM_PANEL.fg, 4)}, 0 12px 26px ${panelColorTint("#000", 20)}`,
} satisfies CSSProperties;

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.max(0, value).toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatDiskBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0.0 B";
  const units = ["B", "K", "M", "G", "T"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "-";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function usageColor(value: number): string {
  if (value >= 86) return TERM_PANEL.red;
  if (value >= 62) return TERM_PANEL.yellow;
  return PANEL_ACCENT;
}

function usageTextColor(value: number): string {
  if (value >= 86) return TERM_PANEL.red;
  if (value >= 62) return TERM_PANEL.yellow;
  return TERM_PANEL.fg;
}

function cpuSegmentColor(segmentRatio: number): string {
  if (segmentRatio >= 0.86) return TERM_PANEL.red;
  if (segmentRatio >= 0.62) return TERM_PANEL.yellow;
  return TERM_PANEL.green;
}

function ResourceCard({
  icon,
  title,
  accent = MODULE_TITLE_COLOR,
  right,
  children,
}: {
  icon: ReactNode;
  title: string;
  accent?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="shrink-0 rounded-xl border p-3 transition-colors duration-300" style={CARD_STYLE}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
            style={{
              color: accent,
              backgroundColor: TERM_PANEL.cardInner,
              borderColor: panelColorTint(accent, 18, TERM_PANEL.border),
              boxShadow: "none",
            }}
          >
            {icon}
          </span>
          <span className="truncate text-[13px] font-bold tracking-wide" style={{ color: MODULE_TITLE_COLOR }}>
            {title}
          </span>
        </div>
        {right ? <div className="min-w-0 shrink-0">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

function InlineEmpty({ text }: { text: string }) {
  return (
    <div className="rounded-lg border px-2.5 py-2 text-[11px]" style={{ borderColor: TERM_PANEL.border, color: TERM_PANEL.dim }}>
      {text}
    </div>
  );
}

function MetricLine({ label, value, color = TERM_PANEL.fg }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b py-1.5 last:border-b-0" style={{ borderColor: panelColorTint(TERM_PANEL.border, 72) }}>
      <span className="truncate text-[11px]" style={{ color: TERM_PANEL.dim }}>{label}</span>
      <span className="shrink-0 text-right text-[12px] font-semibold tabular-nums" style={{ color }}>{value}</span>
    </div>
  );
}

function LegendMetricLine({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b py-1.5 last:border-b-0"
      style={{ borderColor: panelColorTint(TERM_PANEL.border, 72) }}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: TERM_PANEL.dim }}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="truncate">{label}</span>
      </span>
      <span className="shrink-0 text-right text-[12px] font-semibold tabular-nums" style={{ color }}>{formatBytes(value)}</span>
      <span className="w-10 shrink-0 text-right text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
        {formatPercent((value / Math.max(1, total)) * 100)}
      </span>
    </div>
  );
}

function StatusPill({ children, color = PANEL_SOFT_FG }: { children: ReactNode; color?: string }) {
  return (
    <span
      className="rounded-md border px-2.5 py-1 text-[11px] font-semibold tabular-nums"
      style={{ borderColor: TERM_PANEL.border, color, backgroundColor: TERM_PANEL.cardInner }}
    >
      {children}
    </span>
  );
}

interface TrendSeries {
  points: number[];
  color: string;
  mode?: "full" | "up" | "down";
  max?: number;
}

interface DiskTotals {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  readBytesPerSec: number;
  writeBytesPerSec: number;
}

function getDiskTotals(snapshot: SystemResourceSnapshot): DiskTotals {
  return snapshot.disks.reduce(
    (acc, disk) => ({
      totalBytes: acc.totalBytes + disk.totalBytes,
      usedBytes: acc.usedBytes + disk.usedBytes,
      availableBytes: acc.availableBytes + disk.availableBytes,
      readBytesPerSec: acc.readBytesPerSec + disk.readBytesPerSec,
      writeBytesPerSec: acc.writeBytesPerSec + disk.writeBytesPerSec,
    }),
    { totalBytes: 0, usedBytes: 0, availableBytes: 0, readBytesPerSec: 0, writeBytesPerSec: 0 }
  );
}

function TrendChart({
  series,
  height = 58,
  max,
  split = false,
  areaOpacity = 0.94,
  fadeStartOpacity = 0.66,
  fadeEndOpacity = 0.06,
}: {
  series: TrendSeries[];
  height?: number;
  max?: number;
  split?: boolean;
  areaOpacity?: number;
  fadeStartOpacity?: number;
  fadeEndOpacity?: number;
}) {
  const gradientId = useId();
  const allPoints = series.flatMap((line) => line.points);
  const scaleMax = Math.max(1, max ?? Math.max(1, ...allPoints));
  const safeSeries = series.map((line) => ({
    ...line,
    points: line.points.length >= 2 ? line.points : [line.points[0] ?? 0, line.points[0] ?? 0],
  }));
  const splitGapPx = 20;
  const splitBaselineOffset = (splitGapPx / 2 / Math.max(1, height - 2)) * 100;
  const splitUpBaseY = 50 - splitBaselineOffset;
  const splitDownBaseY = 50 + splitBaselineOffset;
  const splitAmplitude = 42 - splitBaselineOffset;
  const guideLines = split
    ? [
        { y: 8, dashed: false, strong: false },
        { y: 25, dashed: true, strong: false },
        { y: 50, dashed: false, strong: true },
        { y: 75, dashed: true, strong: false },
        { y: 92, dashed: false, strong: false },
      ]
    : [
        { y: 25, dashed: false, strong: false },
        { y: 50, dashed: false, strong: false },
        { y: 75, dashed: false, strong: false },
      ];

  const toCoords = (points: number[], mode: TrendSeries["mode"] = "full", seriesMax?: number) => points.map((point, index) => {
    const x = points.length === 1 ? 0 : (index / (points.length - 1)) * 100;
    const normalized = clampRatio(point / Math.max(1, seriesMax ?? scaleMax));
    const y = mode === "up"
      ? splitUpBaseY - normalized * splitAmplitude
      : mode === "down"
        ? splitDownBaseY + normalized * splitAmplitude
        : 90 - normalized * 72;
    return [x, y] as const;
  });

  const linePath = (coords: ReadonlyArray<readonly [number, number]>) => {
    if (coords.length < 2) {
      const [x = 0, y = 50] = coords[0] ?? [];
      return `M${x.toFixed(2)},${y.toFixed(2)}`;
    }

    const parts = [`M${coords[0][0].toFixed(2)},${coords[0][1].toFixed(2)}`];
    for (let index = 0; index < coords.length - 1; index += 1) {
      const [p0x, p0y] = coords[index - 1] ?? coords[index];
      const [p1x, p1y] = coords[index];
      const [p2x, p2y] = coords[index + 1];
      const [p3x, p3y] = coords[index + 2] ?? coords[index + 1];
      const c1x = p1x + (p2x - p0x) / 6;
      const c1y = p1y + (p2y - p0y) / 6;
      const c2x = p2x - (p3x - p1x) / 6;
      const c2y = p2y - (p3y - p1y) / 6;
      parts.push(`C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2x.toFixed(2)},${p2y.toFixed(2)}`);
    }
    return parts.join(" ");
  };

  const areaPath = (coords: ReadonlyArray<readonly [number, number]>, mode: TrendSeries["mode"] = "full") => {
    const baseY = mode === "up" ? splitUpBaseY : mode === "down" ? splitDownBaseY : 96;
    const first = coords[0];
    const last = coords[coords.length - 1];
    return `${linePath(coords)} L${last[0].toFixed(2)},${baseY} L${first[0].toFixed(2)},${baseY} Z`;
  };

  return (
    <div className="relative overflow-hidden rounded-lg border" style={{ height, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
        <defs>
          <linearGradient id={`${gradientId}-fade`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity={fadeStartOpacity} />
            <stop offset="52%" stopColor="white" stopOpacity={Math.max(fadeEndOpacity, fadeStartOpacity * 0.42)} />
            <stop offset="100%" stopColor="white" stopOpacity={fadeEndOpacity} />
          </linearGradient>
          <mask id={`${gradientId}-mask`}>
            <rect width="100" height="100" fill={`url(#${gradientId}-fade)`} />
          </mask>
        </defs>
        {guideLines.map((guide) => (
          <line
            key={guide.y}
            x1="0"
            y1={guide.y}
            x2="100"
            y2={guide.y}
            stroke={guide.strong ? TERM_PANEL.dim : TERM_PANEL.border}
            strokeWidth={guide.strong ? "1" : "0.7"}
            vectorEffect="non-scaling-stroke"
            opacity={guide.strong ? "0.8" : "0.55"}
            strokeDasharray={guide.dashed ? "2 4" : undefined}
          />
        ))}
        {safeSeries.map((line, index) => {
          const coords = toCoords(line.points, line.mode, line.max);
          return (
            <g key={`${line.color}-${index}`}>
              <path d={areaPath(coords, line.mode)} fill={line.color} mask={`url(#${gradientId}-mask)`} opacity={areaOpacity} />
              <path d={linePath(coords)} fill="none" stroke={line.color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6" style={{ background: `linear-gradient(to top, ${TERM_PANEL.card}, transparent)` }} />
    </div>
  );
}

function SystemCard({ snapshot }: { snapshot: SystemResourceSnapshot }) {
  const { t } = useI18n();
  const copyIp = useCallback(() => {
    if (!snapshot.ipAddress) return;
    void navigator.clipboard?.writeText(snapshot.ipAddress);
  }, [snapshot.ipAddress]);

  return (
    <ResourceCard
      icon={<Server size={15} />}
      title={t("systemResources.ip")}
      accent={MODULE_TITLE_COLOR}
      right={snapshot.ipAddress ? (
        <button
          type="button"
          onClick={copyIp}
          className="ui-focus-ring inline-flex max-w-[150px] items-center gap-1 rounded-md border px-2 py-1 text-[11px] tabular-nums"
          style={{ color: TERM_PANEL.fg, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}
          title={t("systemResources.copyIp")}
          aria-label={t("systemResources.copyIp")}
        >
          <span className="truncate">{snapshot.ipAddress}</span>
          <Copy size={11} className="shrink-0" />
        </button>
      ) : null}
    >
      <div className="grid grid-cols-2 gap-2">
        <StatusPill>{snapshot.osName || "-"}</StatusPill>
        <StatusPill>{t("systemResources.cpuTopology", {
          cores: snapshot.cpu.physicalCoreCount,
          threads: snapshot.cpu.logicalProcessorCount,
        })}</StatusPill>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1">
        <MetricLine label={t("systemResources.host")} value={snapshot.hostName ?? "-"} />
        <MetricLine label={t("systemResources.uptime")} value={formatUptime(snapshot.uptimeSeconds)} />
      </div>
    </ResourceCard>
  );
}

function CpuCard({ snapshot, history }: { snapshot: SystemResourceSnapshot; history: SystemResourceSnapshot[] }) {
  const { t } = useI18n();
  const [coresExpanded, setCoresExpanded] = useState(false);
  const corePanelId = useId();
  const points = history.length > 0 ? history.map((item) => item.cpu.usagePercent) : [snapshot.cpu.usagePercent];
  const segmentCount = 14;

  return (
    <ResourceCard
      icon={<Cpu size={15} />}
      title={t("systemResources.cpu")}
      accent={MODULE_TITLE_COLOR}
      right={<span className="text-[12px] tabular-nums" style={{ color: TERM_PANEL.dim }}>{formatPercent(snapshot.cpu.usagePercent)}</span>}
    >
      <TrendChart
        series={[{ points, color: PANEL_ACCENT }]}
        height={70}
        max={100}
        areaOpacity={0.95}
        fadeStartOpacity={0.72}
        fadeEndOpacity={0.1}
      />

      <button
        type="button"
        onClick={() => setCoresExpanded((value) => !value)}
        className="ui-focus-ring mt-3 flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold"
        style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner, color: PANEL_SOFT_FG }}
        aria-expanded={coresExpanded}
        aria-controls={corePanelId}
        aria-label={coresExpanded ? t("systemResources.hideThreads") : t("systemResources.showThreads")}
      >
        <span>{t("systemResources.threadUnit", { count: snapshot.cpu.logicalProcessorCount })}</span>
        <ChevronDown
          size={13}
          className={`transition-transform ${coresExpanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {coresExpanded ? (
        <div
          id={corePanelId}
          className="mt-2 grid gap-1.5"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))" }}
        >
          {snapshot.cpuCores.map((core) => {
            const activeSegments = Math.max(1, Math.round(clampRatio(core.usagePercent / 100) * segmentCount));
            return (
              <div
                key={core.index}
                className="grid min-w-0 grid-cols-[14px_minmax(0,1fr)_34px] items-center gap-1.5 rounded-md border px-1.5 py-1"
                style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}
              >
                <span className="text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>{core.index}</span>
                <span className="flex min-w-0 items-center gap-[2px] overflow-hidden">
                  {Array.from({ length: segmentCount }).map((_, index) => {
                    const segmentRatio = (index + 1) / segmentCount;
                    const active = index < activeSegments;
                    return (
                      <span
                        key={index}
                        className="h-[10px] w-[3px] shrink-0 rounded-[1px]"
                        style={{
                          backgroundColor: active ? cpuSegmentColor(segmentRatio) : panelColorTint(TERM_PANEL.fg, 10, TERM_PANEL.bg),
                          opacity: active ? 0.95 : 0.78,
                        }}
                      />
                    );
                  })}
                </span>
                <span className="text-right text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
                  {formatPercent(core.usagePercent)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </ResourceCard>
  );
}

function MemoryCard({ snapshot }: { snapshot: SystemResourceSnapshot }) {
  const { t } = useI18n();
  const total = Math.max(1, snapshot.memory.totalBytes);
  const used = Math.min(total, Math.max(0, snapshot.memory.usedBytes));
  const available = Math.max(0, snapshot.memory.availableBytes);
  const cached = Math.max(0, snapshot.memory.cachedBytes ?? total - used - available);
  const free = Math.max(0, snapshot.memory.freeBytes ?? 0);
  const ratio = clampRatio(used / total);
  const memoryRows = [
    { label: t("systemResources.used"), value: used, color: TERM_PANEL.red },
    { label: t("systemResources.cache"), value: cached, color: TERM_PANEL.yellow },
    { label: t("systemResources.free"), value: free, color: TERM_PANEL.green },
    { label: t("systemResources.available"), value: available, color: PANEL_SOFT_FG },
  ];

  return (
    <ResourceCard
      icon={<MemoryStick size={15} />}
      title={t("systemResources.memory")}
      accent={MODULE_TITLE_COLOR}
      right={<span className="text-[12px] tabular-nums" style={{ color: TERM_PANEL.dim }}><span style={{ color: TERM_PANEL.fg }}>{formatBytes(used)}</span> / {formatBytes(total)}</span>}
    >
      <div className="grid grid-cols-[86px_minmax(0,1fr)] items-center gap-6">
        <Donut
          size={86}
          thickness={10}
          segments={memoryRows.map((row) => ({ value: row.value, color: row.color }))}
        >
          <div className="text-center leading-tight">
            <div className="text-[18px] font-bold tabular-nums" style={{ color: TERM_PANEL.fg }}>{formatPercent(ratio * 100)}</div>
            <div className="text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>{formatBytes(used)}</div>
          </div>
        </Donut>
        <div className="min-w-0">
          {memoryRows.map((row) => (
            <LegendMetricLine
              key={row.label}
              label={row.label}
              value={row.value}
              total={total}
              color={row.color}
            />
          ))}
        </div>
      </div>
    </ResourceCard>
  );
}

function NetworkCard({ snapshot, history }: { snapshot: SystemResourceSnapshot; history: SystemResourceSnapshot[] }) {
  const { t } = useI18n();
  const uploadPoints = history.length > 0 ? history.map((item) => item.network.uploadBytesPerSec) : [snapshot.network.uploadBytesPerSec];
  const downloadPoints = history.length > 0 ? history.map((item) => item.network.downloadBytesPerSec) : [snapshot.network.downloadBytesPerSec];
  const uploadMax = Math.max(1, ...uploadPoints);
  const downloadMax = Math.max(1, ...downloadPoints);
  const todayLabel = t("systemResources.todayTotal");

  return (
    <ResourceCard
      icon={<Network size={15} />}
      title={t("systemResources.network")}
      accent={MODULE_TITLE_COLOR}
      right={(
        <span className="flex items-center gap-3 text-[10px]">
          <span className="inline-flex items-center gap-1.5 leading-none" style={{ color: NETWORK_UPLOAD_COLOR }}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: NETWORK_UPLOAD_COLOR }} />
            <span>{t("systemResources.upload")}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 leading-none" style={{ color: NETWORK_DOWNLOAD_COLOR }}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: NETWORK_DOWNLOAD_COLOR }} />
            <span>{t("systemResources.download")}</span>
          </span>
        </span>
      )}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_80px] items-stretch gap-3">
        <TrendChart
          height={80}
          split
          areaOpacity={0.98}
          fadeStartOpacity={0.72}
          fadeEndOpacity={0.08}
          series={[
            { points: uploadPoints, color: NETWORK_UPLOAD_COLOR, mode: "up", max: uploadMax },
            { points: downloadPoints, color: NETWORK_DOWNLOAD_COLOR, mode: "down", max: downloadMax },
          ]}
        />
        <div
          className="flex min-w-0 flex-col justify-center gap-2 border-l pl-3"
          style={{ borderColor: TERM_PANEL.border }}
        >
          <div
            className="min-w-0"
            title={`${t("systemResources.upload")} ${formatRate(snapshot.network.uploadBytesPerSec)} · ${todayLabel} ${formatBytes(snapshot.network.todayUploadedBytes)}`}
            aria-label={`${t("systemResources.upload")} ${formatRate(snapshot.network.uploadBytesPerSec)} ${todayLabel} ${formatBytes(snapshot.network.todayUploadedBytes)}`}
          >
            <div className="flex min-w-0 items-center gap-1 text-[11px] font-semibold" style={{ color: NETWORK_UPLOAD_COLOR }}>
              <Upload size={12} className="shrink-0" />
              <span className="truncate tabular-nums">{formatRate(snapshot.network.uploadBytesPerSec)}</span>
            </div>
            <div className="mt-0.5 truncate text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
              {formatBytes(snapshot.network.todayUploadedBytes)}
            </div>
          </div>
          <div
            className="min-w-0"
            title={`${t("systemResources.download")} ${formatRate(snapshot.network.downloadBytesPerSec)} · ${todayLabel} ${formatBytes(snapshot.network.todayDownloadedBytes)}`}
            aria-label={`${t("systemResources.download")} ${formatRate(snapshot.network.downloadBytesPerSec)} ${todayLabel} ${formatBytes(snapshot.network.todayDownloadedBytes)}`}
          >
            <div className="flex min-w-0 items-center gap-1 text-[11px] font-semibold" style={{ color: NETWORK_DOWNLOAD_COLOR }}>
              <Download size={12} className="shrink-0" />
              <span className="truncate tabular-nums">{formatRate(snapshot.network.downloadBytesPerSec)}</span>
            </div>
            <div className="mt-0.5 truncate text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
              {formatBytes(snapshot.network.todayDownloadedBytes)}
            </div>
          </div>
        </div>
      </div>
    </ResourceCard>
  );
}

function DiskCard({ snapshot }: { snapshot: SystemResourceSnapshot; history: SystemResourceSnapshot[] }) {
  const { t } = useI18n();
  const totals = getDiskTotals(snapshot);
  const ratio = clampRatio(totals.usedBytes / Math.max(1, totals.totalBytes));
  const usagePercent = ratio * 100;
  const color = usagePercent >= 94 ? TERM_PANEL.red : usagePercent >= 86 ? TERM_PANEL.yellow : PANEL_ACCENT;
  const percentColor = usagePercent >= 94 ? TERM_PANEL.red : usagePercent >= 86 ? TERM_PANEL.yellow : TERM_PANEL.fg;
  const readColor = DISK_READ_COLOR;
  const writeColor = DISK_WRITE_COLOR;
  const fileSystemType = Array.from(
    new Set(snapshot.disks.map((disk) => disk.fileSystem.trim()).filter(Boolean))
  ).join(" / ") || t("systemResources.unavailable");
  const usedBarBackground =
    usagePercent >= 75
      ? `linear-gradient(90deg, ${PANEL_ACCENT} 0%, ${PANEL_ACCENT} 82%, ${TERM_PANEL.yellow} 82%, ${TERM_PANEL.yellow} 100%)`
      : color;
  const diskRows = [
    { label: t("systemResources.used"), value: formatDiskBytes(totals.usedBytes), color: PANEL_ACCENT },
    { label: t("systemResources.available"), value: formatDiskBytes(totals.availableBytes), color: PANEL_SOFT_FG },
    { label: t("systemResources.diskType"), value: fileSystemType, color: TERM_PANEL.yellow },
  ];

  return (
    <ResourceCard
      icon={<HardDrive size={15} />}
      title={t("systemResources.disk")}
      accent={MODULE_TITLE_COLOR}
      right={snapshot.disks.length > 0 ? <span className="text-[12px] tabular-nums" style={{ color: TERM_PANEL.dim }}><span style={{ color: TERM_PANEL.fg }}>{formatDiskBytes(totals.usedBytes)}</span> / {formatDiskBytes(totals.totalBytes)}</span> : null}
    >
      {snapshot.disks.length === 0 ? (
        <InlineEmpty text={t("systemResources.unavailable")} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex w-[86px] shrink-0 items-center justify-center">
            <Donut
              size={86}
              thickness={8}
              segments={[
                { value: totals.usedBytes, color },
                { value: totals.availableBytes, color: TERM_PANEL.track },
              ]}
            >
              <div className="text-center leading-tight">
                <div className="text-[19px] font-bold tabular-nums" style={{ color: percentColor }}>{formatPercent(usagePercent)}</div>
                <div className="text-[10px]" style={{ color: TERM_PANEL.dim }}>{t("systemResources.used")}</div>
              </div>
            </Donut>
          </div>

          <div className="grid min-w-[104px] flex-1 grid-cols-[auto_auto] items-center justify-end gap-x-5 gap-y-2 pr-2 text-[11px]">
            {diskRows.map((row) => (
              <Fragment key={row.label}>
                <span className="flex min-w-0 items-center gap-1.5" style={{ color: TERM_PANEL.dim }}>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
                  <span className="truncate">{row.label}</span>
                </span>
                <span className="max-w-[92px] truncate text-right text-[12px] font-semibold tabular-nums" style={{ color: TERM_PANEL.dim }}>{row.value}</span>
              </Fragment>
            ))}
          </div>

          <div className="min-w-[132px] flex-[1.15] border-l pl-3" style={{ borderColor: TERM_PANEL.border }}>
            <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate font-semibold" style={{ color: TERM_PANEL.fg }}>{t("systemResources.total")}</span>
              <span className="shrink-0 tabular-nums" style={{ color: TERM_PANEL.dim }}>{formatPercent(usagePercent)}</span>
            </div>
            <div className="mb-3 h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: TERM_PANEL.track }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${usagePercent.toFixed(1)}%`,
                  background: usedBarBackground,
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border p-2" style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
                <div className="text-[10px]" style={{ color: TERM_PANEL.dim }}>{t("systemResources.readPerSecond")}</div>
                <div className="mt-0.5 text-[12px] font-semibold tabular-nums" style={{ color: readColor }}>{formatDiskBytes(totals.readBytesPerSec)}</div>
              </div>
              <div className="rounded-lg border p-2" style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
                <div className="text-[10px]" style={{ color: TERM_PANEL.dim }}>{t("systemResources.writePerSecond")}</div>
                <div className="mt-0.5 text-[12px] font-semibold tabular-nums" style={{ color: writeColor }}>{formatDiskBytes(totals.writeBytesPerSec)}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </ResourceCard>
  );
}

function GpuCard({ snapshot, history }: { snapshot: SystemResourceSnapshot; history: SystemResourceSnapshot[] }) {
  const { t } = useI18n();
  const points = history
    .map((item) => item.gpu?.usagePercent)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const usage = snapshot.gpu?.usagePercent ?? 0;
  const displayPoints = points.length > 0 ? points : [usage];
  const average = displayPoints.reduce((sum, value) => sum + value, 0) / Math.max(1, displayPoints.length);
  const peak = Math.max(usage, ...displayPoints);
  const color = usageColor(usage);
  const segmentCount = 18;
  const activeSegments = Math.round(clampRatio(usage / 100) * segmentCount);
  const loadState =
    usage >= 86
      ? t("systemResources.gpuLoadCritical")
      : usage >= 62
        ? t("systemResources.gpuLoadHigh")
        : usage >= 25
          ? t("systemResources.gpuLoadNormal")
          : t("systemResources.gpuLoadLow");

  return (
    <ResourceCard
      icon={<Gauge size={15} />}
      title={t("systemResources.gpu")}
      accent={MODULE_TITLE_COLOR}
      right={snapshot.gpu ? (
        <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold" style={{ color, borderColor: panelColorTint(color, 28, TERM_PANEL.border), backgroundColor: TERM_PANEL.cardInner }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
          {loadState}
        </span>
      ) : null}
    >
      {!snapshot.gpu ? (
        <InlineEmpty text={t("systemResources.gpuUnavailable")} />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
            <div className="flex min-h-[88px] flex-col justify-between rounded-lg border p-2.5" style={{ borderColor: panelColorTint(color, 24, TERM_PANEL.border), backgroundColor: TERM_PANEL.cardInner }}>
              <div className="text-[10px] font-semibold uppercase" style={{ color: TERM_PANEL.dim }}>{t("systemResources.gpuLoad")}</div>
              <div>
                <div className="text-[28px] font-bold leading-none tabular-nums" style={{ color: usageTextColor(usage) }}>{formatPercent(usage)}</div>
                <div className="mt-1 text-[10px]" style={{ color: TERM_PANEL.dim }}>{t("systemResources.current")}</div>
              </div>
            </div>
            <div className="min-w-0 space-y-2">
              <div className="text-[10px]" style={{ color: TERM_PANEL.dim }}>{t("systemResources.gpuTrend")}</div>
              <TrendChart series={[{ points: displayPoints, color: TERM_PANEL.magenta }]} height={46} max={100} areaOpacity={0.88} fadeStartOpacity={0.62} fadeEndOpacity={0.08} />
              <div className="grid grid-cols-2 gap-2">
                <div className="min-w-0 rounded-lg border px-2 py-1.5" style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
                  <div className="truncate text-[10px]" style={{ color: TERM_PANEL.dim }}>{t("systemResources.average")}</div>
                  <div className="mt-0.5 text-[12px] font-semibold tabular-nums" style={{ color: usageTextColor(average) }}>{formatPercent(average)}</div>
                </div>
                <div className="min-w-0 rounded-lg border px-2 py-1.5" style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
                  <div className="truncate text-[10px]" style={{ color: TERM_PANEL.dim }}>{t("systemResources.peak")}</div>
                  <div className="mt-0.5 text-[12px] font-semibold tabular-nums" style={{ color: usageTextColor(peak) }}>{formatPercent(peak)}</div>
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-lg border p-2" style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
            <div className="mb-2 flex items-center justify-between text-[10px]" style={{ color: TERM_PANEL.dim }}>
              <span>{t("systemResources.gpuThreshold")}</span>
              <span className="tabular-nums">0 / 50 / 100</span>
            </div>
            <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${segmentCount}, minmax(0, 1fr))` }}>
              {Array.from({ length: segmentCount }).map((_, index) => {
                const segmentRatio = (index + 1) / segmentCount;
                const active = index < activeSegments;
                return (
                  <span
                    key={index}
                    className="h-[18px] rounded-[2px]"
                    style={{
                      backgroundColor: active ? cpuSegmentColor(segmentRatio) : panelColorTint(TERM_PANEL.fg, 10, TERM_PANEL.bg),
                      opacity: active ? 0.96 : 0.55,
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </ResourceCard>
  );
}

function ProcessCard({ snapshot }: { snapshot: SystemResourceSnapshot }) {
  const { t } = useI18n();
  const rows = snapshot.topProcesses.slice(0, 5);

  return (
    <ResourceCard icon={<ListOrdered size={15} />} title={t("systemResources.topProcesses")} accent={MODULE_TITLE_COLOR}>
      {rows.length === 0 ? (
        <InlineEmpty text={t("systemResources.noProcesses")} />
      ) : (
        <div className="overflow-hidden rounded-lg border" style={{ borderColor: TERM_PANEL.border }}>
          <div className="grid grid-cols-[42px_42px_minmax(0,1fr)_44px] gap-2 border-b px-2 py-1.5 text-[10px] font-semibold" style={{ color: TERM_PANEL.dim, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
            <span>CPU</span>
            <span>{t("systemResources.memoryShort")}</span>
            <span>{t("systemResources.software")}</span>
            <span className="text-right">PID</span>
          </div>
          {rows.map((process) => {
            const command = process.command || process.name;
            const displayName = process.displayName?.trim() || command;
            const title = displayName === command ? displayName : `${displayName}\n${command}`;
            return (
              <div
                key={`${process.pid}-${process.name}`}
                className="grid grid-cols-[42px_42px_minmax(0,1fr)_44px] gap-2 border-b px-2 py-1.5 text-[11px] last:border-b-0"
                style={{ borderColor: panelColorTint(TERM_PANEL.border, 78), backgroundColor: TERM_PANEL.card }}
              >
                <span className="tabular-nums" style={{ color: TERM_PANEL.fg }}>{formatPercent(process.cpuUsagePercent)}</span>
                <span className="tabular-nums" style={{ color: TERM_PANEL.fg }}>{formatPercent(process.memoryUsagePercent)}</span>
                <span className="flex min-w-0 items-center gap-1.5" title={title} style={{ color: TERM_PANEL.fg }}>
                  {process.iconDataUrl ? (
                    <img src={process.iconDataUrl} alt="" width={16} height={16} className="shrink-0 rounded-[2px]" draggable={false} />
                  ) : (
                    <AppWindow size={14} className="shrink-0" aria-hidden="true" style={{ color: TERM_PANEL.dim }} />
                  )}
                  <span className="truncate">{displayName}</span>
                </span>
                <span className="truncate text-right tabular-nums" title={process.pid} style={{ color: TERM_PANEL.dim }}>{process.pid}</span>
              </div>
            );
          })}
        </div>
      )}
    </ResourceCard>
  );
}

export function SystemResourcesPanel({ open, visible = true, embedded = false }: SystemResourcesPanelProps) {
  const { t } = useI18n();
  const panelActive = open && visible;
  const cardVisibility = useSettingsStore((s) => s.systemResourceCardVisibility);
  const cardOrder = useSettingsStore((s) => s.systemResourceCardOrder);

  const orderedCards = useMemo(() => {
    const configured = cardOrder.filter((key): key is SystemResourceCardKey => SYSTEM_RESOURCE_CARD_KEYS.includes(key));
    const missing = SYSTEM_RESOURCE_CARD_KEYS.filter((key) => !configured.includes(key));
    return [...configured, ...missing].filter((key) => cardVisibility[key]);
  }, [cardOrder, cardVisibility]);

  const samplingOptions = useMemo<SystemResourceSnapshotOptions>(() => ({
    fullDetail: true,
    system: cardVisibility.system,
    cpu: cardVisibility.cpu,
    memory: cardVisibility.memory,
    network: cardVisibility.network,
    disk: cardVisibility.disk,
    gpu: cardVisibility.gpu,
    processes: cardVisibility.processes,
  }), [cardVisibility]);

  const { snapshot, history, loading, error, refresh } = useSystemResources(
    panelActive && orderedCards.length > 0,
    samplingOptions,
    2500,
    SYSTEM_RESOURCES_RUNTIME_CACHE_KEY
  );

  const sampleTime = useMemo(() => {
    if (!snapshot?.sampledAt) return null;
    return new Date(snapshot.sampledAt).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }, [snapshot?.sampledAt]);

  if (!panelActive) return null;

  const containerClassName = embedded
    ? "flex h-full min-h-0 flex-col gap-2.5 overflow-y-auto p-2 font-mono ui-thin-scroll"
    : "relative z-[1] flex w-[280px] shrink-0 flex-col gap-2.5 overflow-y-auto border-l border-border p-2 font-mono ui-thin-scroll";

  const Container = embedded ? "div" : "aside";

  const renderCard = (key: SystemResourceCardKey) => {
    if (!snapshot) return null;
    switch (key) {
      case "system":
        return <SystemCard key={key} snapshot={snapshot} />;
      case "cpu":
        return <CpuCard key={key} snapshot={snapshot} history={history} />;
      case "memory":
        return <MemoryCard key={key} snapshot={snapshot} />;
      case "network":
        return <NetworkCard key={key} snapshot={snapshot} history={history} />;
      case "disk":
        return <DiskCard key={key} snapshot={snapshot} history={history} />;
      case "gpu":
        return <GpuCard key={key} snapshot={snapshot} history={history} />;
      case "processes":
        return <ProcessCard key={key} snapshot={snapshot} />;
      default:
        return null;
    }
  };

  return (
    <Container
      className={containerClassName}
      style={{
        backgroundColor: TERM_PANEL.bg,
        backgroundImage: `linear-gradient(90deg, ${panelColorTint(TERM_PANEL.fg, 3)} 1px, transparent 1px), linear-gradient(${panelColorTint(TERM_PANEL.fg, 3)} 1px, transparent 1px)`,
        backgroundSize: "22px 22px, 22px 22px",
        ...PANEL_SCROLLBAR_STYLE,
      }}
    >
      <div className="flex items-center justify-between px-1 py-1">
        <span className="flex min-w-0 items-center gap-2 text-[15px] font-bold tracking-wide" style={{ color: MODULE_TITLE_COLOR }}>
          <span className="flex h-6 w-6 items-center justify-center rounded-md border" style={{ color: MODULE_TITLE_COLOR, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
            <Server size={15} />
          </span>
          <span className="truncate">{t("systemResources.title")}</span>
        </span>
        <span className="flex items-center gap-1.5 text-[10px]" style={{ color: TERM_PANEL.dim }}>
          {sampleTime && <span className="tabular-nums">{sampleTime}</span>}
          <button
            type="button"
            onClick={() => void refresh(true)}
            className={`ui-focus-ring rounded-md border p-1 ${loading ? "animate-spin" : ""}`}
            style={{ color: PANEL_SOFT_FG, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}
            title={t("systemResources.refresh")}
            aria-label={t("systemResources.refresh")}
          >
            <RefreshCw size={12} />
          </button>
        </span>
      </div>

      {loading && !snapshot ? (
        <EmptyHint text={t("common.loading")} />
      ) : error && !snapshot ? (
        <EmptyHint text={t("systemResources.loadFailed")} />
      ) : snapshot ? (
        <>
          {orderedCards.map(renderCard)}

          {error ? (
            <div
              className="rounded-lg border px-2 py-1.5 text-[10px]"
              style={{
                borderColor: panelColorTint(TERM_PANEL.red, 24),
                color: TERM_PANEL.red,
                backgroundColor: panelColorTint(TERM_PANEL.red, 8),
              }}
            >
              <span className="inline-flex items-center gap-1"><Activity size={10} />{t("systemResources.refreshFailed")}</span>
            </div>
          ) : null}
        </>
      ) : null}
    </Container>
  );
}
