import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useI18n } from "../../../shared/i18n/index";
import { useSettingsStore, type TerminalStatusBarItemKey } from "../../../shared/preferences/settingsStore";
import { formatCompactCount, formatCost } from "../../stats/api/termStatsUi";
import { resolveAgentTerminalMetadata } from "../../agents/api/agentTerminal";
import { CliToolIcon } from "../../../shared/ui/CliToolIcon";
import { Portal } from "../../../shared/ui/Portal";
import { resolveCliToolIconKey, type CliToolIconKey } from "../../../shared/lib/cliTools";
import { useProjectStore } from "../../projects/api/projectStore";
import { useTerminalStore } from "../state";
import { useTerminalStatusBarData, type StatusBarTokenTotals } from "../hooks/useTerminalStatusBarData";
import { APP_MEMORY_OPTIMIZE_COOLDOWN_MS, type useAppMemory } from "../hooks/useAppMemory";
import {
  TERMINAL_STATUS_BAR_ITEM_META,
  formatStatusBarBytes,
  formatStatusBarPercent,
  formatStatusBarRate,
} from "../lib/terminalStatusBarItems";

const PLACEHOLDER = "—";
const HIGH_USAGE_PERCENT = 85;
const HOVER_OPEN_DELAY_MS = 280;
const HOVER_CLOSE_DELAY_MS = 120;
const HOVER_CARD_WIDTH = 260;
const HOVER_CARD_GAP = 8;

type ItemTone = "default" | "warn" | "danger" | "accent" | "success";

interface TerminalStatusBarProps {
  onActivateSession?: (sessionId: string) => void | Promise<void>;
  /** 终端主题推导的浮层配色（--menu-*），使悬浮卡与终端配色一致。 */
  menuStyle?: CSSProperties;
}

interface StatusBarDetailRow {
  label: string;
  value: string;
  tone?: ItemTone;
}

/** 单个条目的渲染模型：同一份数据同时驱动信息栏与悬浮卡，保证两者实时一致。 */
interface StatusBarItemModel {
  value: ReactNode;
  tone?: ItemTone;
  /** 品牌图标（Claude/Codex 等），优先于条目默认的线性图标。 */
  brandIcon?: CliToolIconKey | null;
  /** 0~100 的占用率，提供时绘制迷你进度条。 */
  meter?: number | null;
  /** 进行中的操作（如内存优化），图标替换为旋转指示。 */
  busy?: boolean;
  rows?: StatusBarDetailRow[];
  hint?: string;
  onClick?: () => void;
}

interface StatusBarItemProps {
  itemKey: TerminalStatusBarItemKey;
  model: StatusBarItemModel;
  onHoverStart: (key: TerminalStatusBarItemKey, element: HTMLElement) => void;
  onHoverEnd: () => void;
}

function StatusBarItemIcon({
  itemKey,
  brandIcon,
  busy,
  size,
}: {
  itemKey: TerminalStatusBarItemKey;
  brandIcon?: CliToolIconKey | null;
  busy?: boolean;
  size: number;
}) {
  const Icon = TERMINAL_STATUS_BAR_ITEM_META[itemKey].icon;
  if (busy) {
    return (
      <Loader2
        size={size}
        strokeWidth={1.75}
        aria-hidden="true"
        className="ui-terminal-status-bar__icon ui-terminal-status-bar__icon--spin"
      />
    );
  }
  return brandIcon
    ? <CliToolIcon icon={brandIcon} size={size + 2} className="ui-terminal-status-bar__brand" />
    : <Icon size={size} strokeWidth={1.75} aria-hidden="true" className="ui-terminal-status-bar__icon" />;
}

function clampMeter(meter: number): number {
  return Math.min(100, Math.max(0, meter));
}

function StatusBarItem({ itemKey, model, onHoverStart, onHoverEnd }: StatusBarItemProps) {
  const { t } = useI18n();
  const label = t(TERMINAL_STATUS_BAR_ITEM_META[itemKey].labelKey);
  const { value, tone = "default", brandIcon, meter, busy, onClick } = model;
  const content = (
    <>
      <StatusBarItemIcon itemKey={itemKey} brandIcon={brandIcon} busy={busy} size={13} />
      {meter != null && (
        <span className="ui-terminal-status-bar__meter" aria-hidden="true">
          <span style={{ width: `${clampMeter(meter)}%` }} />
        </span>
      )}
      <span className="ui-terminal-status-bar__value">{value}</span>
    </>
  );
  const hoverProps = {
    "data-tone": tone,
    "aria-label": label,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => onHoverStart(itemKey, event.currentTarget),
    onPointerLeave: onHoverEnd,
  };
  if (onClick) {
    return (
      <button
        type="button"
        className="ui-terminal-status-bar__item ui-terminal-status-bar__item--button"
        onClick={onClick}
        {...hoverProps}
      >
        {content}
      </button>
    );
  }
  return (
    <span className="ui-terminal-status-bar__item" {...hoverProps}>
      {content}
    </span>
  );
}

function StatusBarHoverCard({
  itemKey,
  model,
  anchor,
  menuStyle,
  onPointerEnter,
  onPointerLeave,
}: {
  itemKey: TerminalStatusBarItemKey;
  model: StatusBarItemModel;
  anchor: DOMRect;
  menuStyle?: CSSProperties;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const { t } = useI18n();
  const meta = TERMINAL_STATUS_BAR_ITEM_META[itemKey];
  const left = Math.min(
    Math.max(HOVER_CARD_GAP, anchor.left + anchor.width / 2 - HOVER_CARD_WIDTH / 2),
    Math.max(HOVER_CARD_GAP, window.innerWidth - HOVER_CARD_WIDTH - HOVER_CARD_GAP)
  );
  const bottom = window.innerHeight - anchor.top + HOVER_CARD_GAP;
  const tone = model.tone ?? "default";
  return (
    <div
      className="ui-terminal-status-bar-card"
      role="tooltip"
      data-tone={tone}
      style={{ ...menuStyle, left, bottom, width: HOVER_CARD_WIDTH }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="ui-terminal-status-bar-card__header">
        <span className="ui-terminal-status-bar-card__title">
          <StatusBarItemIcon itemKey={itemKey} brandIcon={model.brandIcon} busy={model.busy} size={14} />
          <span>{t(meta.labelKey)}</span>
        </span>
        <span className="ui-terminal-status-bar-card__value">{model.value}</span>
      </div>
      {model.meter != null && (
        <div className="ui-terminal-status-bar-card__meter" aria-hidden="true">
          <span style={{ width: `${clampMeter(model.meter)}%` }} />
        </div>
      )}
      {model.rows && model.rows.length > 0 && (
        <div className="ui-terminal-status-bar-card__rows">
          {model.rows.map((row) => (
            <div key={row.label} className="ui-terminal-status-bar-card__row" data-tone={row.tone ?? "default"}>
              <span className="ui-terminal-status-bar-card__label">{row.label}</span>
              <span className="ui-terminal-status-bar-card__row-value">{row.value}</span>
            </div>
          ))}
        </div>
      )}
      <div className="ui-terminal-status-bar-card__hint">{model.hint ?? t(meta.descriptionKey)}</div>
    </div>
  );
}

/** 悬浮卡的开合节流：进入延迟打开、离开延迟关闭，指针移入卡片时保持打开。 */
function useStatusBarHover() {
  const [hover, setHover] = useState<{ key: TerminalStatusBarItemKey; anchor: DOMRect } | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const openRef = useRef(false);
  openRef.current = hover !== null;

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  }, []);

  const start = useCallback((key: TerminalStatusBarItemKey, element: HTMLElement) => {
    clearTimers();
    // 已有卡片打开时在条目间移动直接切换，避免重复等待。
    if (openRef.current) {
      setHover({ key, anchor: element.getBoundingClientRect() });
      return;
    }
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      setHover({ key, anchor: element.getBoundingClientRect() });
    }, HOVER_OPEN_DELAY_MS);
  }, [clearTimers]);

  const end = useCallback(() => {
    clearTimers();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setHover(null);
    }, HOVER_CLOSE_DELAY_MS);
  }, [clearTimers]);

  const keep = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  return { hover, start, end, keep };
}

function usageTone(percent: number | null | undefined): ItemTone {
  if (percent == null) return "default";
  if (percent >= 95) return "danger";
  if (percent >= HIGH_USAGE_PERCENT) return "warn";
  return "default";
}

type AppMemoryState = ReturnType<typeof useAppMemory>;

const APP_MEMORY_FLASH_MS = 3000;
const MEGABYTE = 1024 * 1024;

function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// 应用内存条目：点击触发优化，完成后短暂高亮释放量，冷却期内不可再次点击。
function useAppMemoryItemModel({ usage, optimizing, lastOptimization, optimize }: AppMemoryState): StatusBarItemModel {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const finishedAt = lastOptimization?.finishedAt ?? 0;
  const flashUntil = finishedAt + APP_MEMORY_FLASH_MS;
  const cooldownUntil = finishedAt + APP_MEMORY_OPTIMIZE_COOLDOWN_MS;

  // 只在高亮结束、冷却结束这两个边界各重渲染一次，不挂常驻计时器。
  useEffect(() => {
    const current = Date.now();
    const nextBoundary = [flashUntil, cooldownUntil].find((boundary) => boundary > current);
    if (!finishedAt || nextBoundary === undefined) return;
    const timer = window.setTimeout(() => setNow(Date.now()), nextBoundary - current + 20);
    return () => window.clearTimeout(timer);
  }, [cooldownUntil, finishedAt, flashUntil, now]);

  const runOptimize = useCallback(async () => {
    try {
      const result = await optimize();
      setNow(Date.now());
      const detailParts = [t("terminalStatusBar.appMemory.optimizedDetail", {
        before: formatStatusBarBytes(result.before.totalBytes),
        after: formatStatusBarBytes(result.after.totalBytes),
      })];
      if (result.orphanKilledCount > 0) {
        detailParts.push(t("terminalStatusBar.appMemory.orphanKilled", { count: result.orphanKilledCount }));
      }
      const detail = detailParts.join(" · ");
      if (result.freedBytes >= MEGABYTE) {
        toast.success(
          t("terminalStatusBar.appMemory.optimized", { freed: formatStatusBarBytes(result.freedBytes) }),
          { description: detail }
        );
      } else {
        toast.info(t("terminalStatusBar.appMemory.alreadyLow"), { description: detail });
      }
    } catch (error) {
      // 已有优化在进行（例如重复点击）时静默忽略，进行中的那次会给出结果。
      if (String(error).includes("app_memory_optimize_busy")) return;
      toast.error(t("terminalStatusBar.appMemory.failed"), { description: String(error) });
    }
  }, [optimize, t]);

  const flashing = !optimizing && lastOptimization !== null
    && lastOptimization.freedBytes >= MEGABYTE && now < flashUntil;
  const coolingDown = !optimizing && lastOptimization !== null && now < cooldownUntil;

  const rows: StatusBarDetailRow[] = [];
  if (usage) {
    rows.push(
      { label: t("terminalStatusBar.appMemory.main"), value: formatStatusBarBytes(usage.main.bytes) },
      {
        label: t("terminalStatusBar.appMemory.webview", { count: usage.webview.processCount }),
        value: formatStatusBarBytes(usage.webview.bytes),
      }
    );
    if (usage.daemon.processCount > 0) {
      rows.push({ label: t("terminalStatusBar.appMemory.daemon"), value: formatStatusBarBytes(usage.daemon.bytes) });
    }
    if (usage.terminal.processCount > 0) {
      rows.push({ label: t("terminalStatusBar.appMemory.terminal"), value: formatStatusBarBytes(usage.terminal.bytes) });
    }
    if (usage.orphan.processCount > 0) {
      rows.push({
        label: t("terminalStatusBar.appMemory.orphan", { count: usage.orphan.processCount }),
        value: formatStatusBarBytes(usage.orphan.bytes),
        tone: "warn",
      });
    }
  }
  if (lastOptimization) {
    rows.push({
      label: [
        t("terminalStatusBar.appMemory.lastResult", {
          time: formatClockTime(lastOptimization.finishedAt),
          freed: formatStatusBarBytes(lastOptimization.freedBytes),
        }),
        ...(lastOptimization.orphanKilledCount > 0
          ? [t("terminalStatusBar.appMemory.orphanKilled", { count: lastOptimization.orphanKilledCount })]
          : []),
      ].join(" · "),
      value: "",
      tone: "success",
    });
  }

  const hints = [
    optimizing
      ? t("terminalStatusBar.appMemory.optimizing")
      : coolingDown
        ? t("terminalStatusBar.appMemory.cooldown")
        : t("terminalStatusBar.appMemory.clickToOptimize"),
  ];
  const orphanCount = usage?.orphan.processCount ?? 0;
  if (orphanCount > 0 && !optimizing) {
    hints.push(t("terminalStatusBar.appMemory.orphanHint", { count: orphanCount }));
  }
  if (usage && !usage.privateWorkingSet) hints.push(t("terminalStatusBar.appMemory.workingSetFallback"));

  let value: ReactNode = usage ? formatStatusBarBytes(usage.totalBytes) : PLACEHOLDER;
  if (optimizing) value = t("terminalStatusBar.appMemory.optimizing");
  else if (flashing && lastOptimization) value = "−" + formatStatusBarBytes(lastOptimization.freedBytes);

  return {
    value,
    // 有孤儿进程时以警示色提示，引导点击清理。
    tone: flashing ? "success" : orphanCount > 0 ? "warn" : "default",
    busy: optimizing,
    rows,
    hint: hints.join(" "),
    onClick: optimizing || coolingDown ? undefined : () => void runOptimize(),
  };
}

// 当前终端的 AI 信息：CLI 工具、Hook 上报的推理强度、仍在运行的子代理数；非 AI 终端不显示。
function useActiveTabAiSummary(enabled: boolean) {
  const { t } = useI18n();
  const projects = useProjectStore((state) => state.projects);
  const { activeSession, subagentCount } = useTerminalStore(
    useShallow((state) => {
      if (!enabled) return { activeSession: undefined, subagentCount: 0 };
      const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
      const subagentCount = activeSession
        ? state.sessions.filter((session) => (
          session.kind === "subagent-transcript"
          && session.subagent?.parentSessionId === activeSession.id
          && !state.subagentTranscripts[session.id]?.ended
        )).length
        : 0;
      return { activeSession, subagentCount };
    })
  );

  return useMemo(() => {
    if (!enabled || !activeSession) return null;
    const project = activeSession.projectId
      ? projects.find((item) => item.id === activeSession.projectId)
      : undefined;
    const metadata = resolveAgentTerminalMetadata(activeSession, project);
    if (!metadata.isAgentSession) return null;
    const toolName = metadata.cliTool ?? "AI";
    // 有品牌图标时图标已表达 CLI 工具，正文只保留推理强度与子代理数。
    const brandIcon = resolveCliToolIconKey(metadata.cliTool);
    const effort = activeSession.cliReasoningEffort?.trim() || null;
    const details: string[] = [];
    if (effort) details.push(effort);
    if (subagentCount > 0) details.push(t("terminalStatusBar.tooltip.subagents", { count: subagentCount }));
    const text = brandIcon ? details.join(" · ") || toolName : [toolName, ...details].join(" · ");
    return { text, toolName, effort, subagentCount, brandIcon };
  }, [activeSession, enabled, projects, subagentCount, t]);
}

export function TerminalStatusBar({ onActivateSession, menuStyle }: TerminalStatusBarProps) {
  const enabled = useSettingsStore((state) => state.terminalStatusBarEnabled);
  if (!enabled) return null;
  return <TerminalStatusBarContent onActivateSession={onActivateSession} menuStyle={menuStyle} />;
}

function TerminalStatusBarContent({ onActivateSession, menuStyle }: TerminalStatusBarProps) {
  const { t } = useI18n();
  const order = useSettingsStore((state) => state.terminalStatusBarOrder);
  const visibility = useSettingsStore((state) => state.terminalStatusBarVisibility);
  const visibleKeys = useMemo(() => order.filter((key) => visibility[key]), [order, visibility]);
  const { snapshot, tokens, sessionCounts, appMemory } = useTerminalStatusBarData(visibleKeys);
  const activeTabAi = useActiveTabAiSummary(visibleKeys.includes("activeTabAi"));
  const { hover, start, end, keep } = useStatusBarHover();
  const appMemoryModel = useAppMemoryItemModel(appMemory);

  const tokenRows = (totals: StatusBarTokenTotals | null | undefined): StatusBarDetailRow[] => (
    totals
      ? [
        { label: t("terminalStatusBar.detail.input"), value: formatCompactCount(totals.input) },
        { label: t("terminalStatusBar.detail.output"), value: formatCompactCount(totals.output) },
        { label: t("terminalStatusBar.detail.cacheRead"), value: formatCompactCount(totals.cacheRead) },
        { label: t("terminalStatusBar.detail.cacheWrite"), value: formatCompactCount(totals.cacheWrite) },
        { label: t("terminalStatusBar.detail.cost"), value: formatCost(totals.costUsd) },
      ]
      : []
  );

  const percentRows = (percent: number | null | undefined): StatusBarDetailRow[] => (
    percent == null
      ? []
      : [{ label: t("terminalStatusBar.detail.usage"), value: formatStatusBarPercent(percent), tone: usageTone(percent) }]
  );

  const buildModel = (key: TerminalStatusBarItemKey): StatusBarItemModel | null => {
    switch (key) {
      case "todayTokens":
        return {
          value: tokens ? formatCompactCount(tokens.all.total) : PLACEHOLDER,
          rows: tokenRows(tokens?.all),
        };
      case "todayCost":
        return {
          value: tokens ? formatCost(tokens.all.costUsd) : PLACEHOLDER,
          rows: tokens
            ? [
              { label: "Claude", value: formatCost(tokens.claude?.costUsd ?? 0) },
              { label: "Codex", value: formatCost(tokens.codex?.costUsd ?? 0) },
              { label: t("terminalStatusBar.detail.total"), value: formatCost(tokens.all.costUsd) },
            ]
            : [],
        };
      case "claudeTokens":
        return {
          brandIcon: "claude-code",
          value: tokens ? formatCompactCount(tokens.claude?.total ?? 0) : PLACEHOLDER,
          rows: tokenRows(tokens?.claude),
        };
      case "codexTokens":
        return {
          brandIcon: "codex",
          value: tokens ? formatCompactCount(tokens.codex?.total ?? 0) : PLACEHOLDER,
          rows: tokenRows(tokens?.codex),
        };
      case "aiRunning":
        return {
          value: sessionCounts ? sessionCounts.running : PLACEHOLDER,
          tone: sessionCounts && sessionCounts.running > 0 ? "accent" : "default",
        };
      case "aiAttention": {
        const targetId = sessionCounts?.attentionSessionId ?? null;
        return {
          value: sessionCounts ? sessionCounts.attention : PLACEHOLDER,
          tone: sessionCounts && sessionCounts.attention > 0 ? "warn" : "default",
          hint: targetId ? t("terminalStatusBar.detail.clickToJump") : t("terminalStatusBar.tooltip.noAttention"),
          onClick: targetId && onActivateSession ? () => void onActivateSession(targetId) : undefined,
        };
      }
      case "activeTabAi":
        return activeTabAi
          ? {
            brandIcon: activeTabAi.brandIcon,
            value: activeTabAi.text,
            rows: [
              { label: t("terminalStatusBar.detail.cli"), value: activeTabAi.toolName },
              { label: t("terminalStatusBar.detail.effort"), value: activeTabAi.effort ?? PLACEHOLDER },
              { label: t("terminalStatusBar.detail.subagents"), value: String(activeTabAi.subagentCount) },
            ],
          }
          : null;
      case "cpu": {
        const percent = snapshot?.cpu.usagePercent;
        const cores = snapshot?.cpu.logicalProcessorCount;
        return {
          value: percent == null ? PLACEHOLDER : formatStatusBarPercent(percent),
          tone: usageTone(percent),
          meter: percent,
          rows: [
            ...percentRows(percent),
            ...(cores ? [{ label: t("terminalStatusBar.detail.logicalCores"), value: String(cores) }] : []),
          ],
        };
      }
      case "memory": {
        const memory = snapshot?.memory;
        const percent = memory && memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : null;
        return {
          value: percent == null ? PLACEHOLDER : formatStatusBarPercent(percent),
          tone: usageTone(percent),
          meter: percent,
          rows: memory
            ? [
              { label: t("terminalStatusBar.detail.used"), value: formatStatusBarBytes(memory.usedBytes), tone: usageTone(percent) },
              { label: t("terminalStatusBar.detail.available"), value: formatStatusBarBytes(memory.availableBytes) },
              { label: t("terminalStatusBar.detail.capacity"), value: formatStatusBarBytes(memory.totalBytes) },
            ]
            : [],
        };
      }
      case "appMemory":
        return appMemoryModel;
      case "gpu": {
        const percent = snapshot?.gpu?.usagePercent;
        const vram = snapshot?.gpu?.dedicatedUsedBytes;
        return {
          value: percent == null ? PLACEHOLDER : formatStatusBarPercent(percent),
          tone: usageTone(percent),
          meter: percent,
          rows: [
            ...percentRows(percent),
            ...(vram != null ? [{ label: t("terminalStatusBar.detail.vram"), value: formatStatusBarBytes(vram) }] : []),
          ],
        };
      }
      case "vram": {
        const bytes = snapshot?.gpu?.dedicatedUsedBytes;
        return { value: bytes == null ? PLACEHOLDER : formatStatusBarBytes(bytes) };
      }
      case "netUp":
      case "netDown": {
        const network = snapshot?.network;
        const rate = key === "netUp" ? network?.uploadBytesPerSec : network?.downloadBytesPerSec;
        const today = key === "netUp" ? network?.todayUploadedBytes : network?.todayDownloadedBytes;
        return {
          value: rate == null ? PLACEHOLDER : formatStatusBarRate(rate),
          rows: today != null
            ? [{ label: t("terminalStatusBar.detail.today"), value: formatStatusBarBytes(today) }]
            : [],
        };
      }
      case "diskRead":
      case "diskWrite": {
        const disks = snapshot?.disks ?? [];
        const field = key === "diskRead" ? "readBytesPerSec" : "writeBytesPerSec";
        const total = disks.reduce((sum, disk) => sum + disk[field], 0);
        return {
          value: snapshot ? formatStatusBarRate(total) : PLACEHOLDER,
          rows: disks.map((disk) => ({
            label: disk.mountPoint || disk.name,
            value: formatStatusBarRate(disk[field]),
          })),
        };
      }
    }
  };

  if (visibleKeys.length === 0) return null;

  const renderItem = (key: TerminalStatusBarItemKey): ReactNode => {
    const model = buildModel(key);
    return model ? <StatusBarItem key={key} itemKey={key} model={model} onHoverStart={start} onHoverEnd={end} /> : null;
  };

  // 参考 Orca：AI 用量靠左、系统资源靠右，组内保持用户设置的顺序。
  const aiKeys = visibleKeys.filter((key) => TERMINAL_STATUS_BAR_ITEM_META[key].group === "ai");
  const systemKeys = visibleKeys.filter((key) => TERMINAL_STATUS_BAR_ITEM_META[key].group === "system");
  // 悬浮卡每次渲染都从最新数据重建，轮询刷新时卡片内容同步更新。
  const hoverModel = hover && visibleKeys.includes(hover.key) ? buildModel(hover.key) : null;

  return (
    <div className="ui-terminal-status-bar" role="status" aria-live="off">
      <div className="ui-terminal-status-bar__group">{aiKeys.map(renderItem)}</div>
      <div className="ui-terminal-status-bar__group ui-terminal-status-bar__group--end">{systemKeys.map(renderItem)}</div>
      {hover && hoverModel && (
        <Portal>
          <StatusBarHoverCard
            itemKey={hover.key}
            model={hoverModel}
            anchor={hover.anchor}
            menuStyle={menuStyle}
            onPointerEnter={keep}
            onPointerLeave={end}
          />
        </Portal>
      )}
    </div>
  );
}
