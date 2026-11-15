import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AppWindow,
  ArrowDown,
  ArrowUp,
  BellRing,
  Bot,
  Brain,
  Coins,
  Cpu,
  Gauge,
  HardDriveDownload,
  HardDriveUpload,
  Layers,
  MemoryStick,
  Sparkles,
  Zap,
} from "lucide-react";
import type { TranslationKey } from "../../../shared/i18n/index";
import type { TerminalStatusBarItemKey } from "../../../shared/preferences/settingsStore";

export type TerminalStatusBarItemGroup = "ai" | "system";

export interface TerminalStatusBarItemMeta {
  icon: LucideIcon;
  group: TerminalStatusBarItemGroup;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  /** 设置页中的示例值，帮助用户在未开启时预估效果。 */
  sample: string;
}

export const TERMINAL_STATUS_BAR_ITEM_META: Record<TerminalStatusBarItemKey, TerminalStatusBarItemMeta> = {
  todayTokens: {
    icon: Zap,
    group: "ai",
    labelKey: "terminalStatusBar.item.todayTokens",
    descriptionKey: "terminalStatusBar.item.todayTokens.description",
    sample: "12.4M",
  },
  todayCost: {
    icon: Coins,
    group: "ai",
    labelKey: "terminalStatusBar.item.todayCost",
    descriptionKey: "terminalStatusBar.item.todayCost.description",
    sample: "$3.42",
  },
  claudeTokens: {
    icon: Sparkles,
    group: "ai",
    labelKey: "terminalStatusBar.item.claudeTokens",
    descriptionKey: "terminalStatusBar.item.claudeTokens.description",
    sample: "Claude 8.1M",
  },
  codexTokens: {
    icon: Bot,
    group: "ai",
    labelKey: "terminalStatusBar.item.codexTokens",
    descriptionKey: "terminalStatusBar.item.codexTokens.description",
    sample: "Codex 4.3M",
  },
  aiRunning: {
    icon: Activity,
    group: "ai",
    labelKey: "terminalStatusBar.item.aiRunning",
    descriptionKey: "terminalStatusBar.item.aiRunning.description",
    sample: "2",
  },
  aiAttention: {
    icon: BellRing,
    group: "ai",
    labelKey: "terminalStatusBar.item.aiAttention",
    descriptionKey: "terminalStatusBar.item.aiAttention.description",
    sample: "1",
  },
  activeTabAi: {
    icon: Brain,
    group: "ai",
    labelKey: "terminalStatusBar.item.activeTabAi",
    descriptionKey: "terminalStatusBar.item.activeTabAi.description",
    sample: "claude · high",
  },
  cpu: {
    icon: Cpu,
    group: "system",
    labelKey: "terminalStatusBar.item.cpu",
    descriptionKey: "terminalStatusBar.item.cpu.description",
    sample: "23%",
  },
  memory: {
    icon: MemoryStick,
    group: "system",
    labelKey: "terminalStatusBar.item.memory",
    descriptionKey: "terminalStatusBar.item.memory.description",
    sample: "61%",
  },
  appMemory: {
    icon: AppWindow,
    group: "system",
    labelKey: "terminalStatusBar.item.appMemory",
    descriptionKey: "terminalStatusBar.item.appMemory.description",
    sample: "412 MB",
  },
  gpu: {
    icon: Gauge,
    group: "system",
    labelKey: "terminalStatusBar.item.gpu",
    descriptionKey: "terminalStatusBar.item.gpu.description",
    sample: "17%",
  },
  vram: {
    icon: Layers,
    group: "system",
    labelKey: "terminalStatusBar.item.vram",
    descriptionKey: "terminalStatusBar.item.vram.description",
    sample: "2.1 GB",
  },
  netUp: {
    icon: ArrowUp,
    group: "system",
    labelKey: "terminalStatusBar.item.netUp",
    descriptionKey: "terminalStatusBar.item.netUp.description",
    sample: "128 KB/s",
  },
  netDown: {
    icon: ArrowDown,
    group: "system",
    labelKey: "terminalStatusBar.item.netDown",
    descriptionKey: "terminalStatusBar.item.netDown.description",
    sample: "2.4 MB/s",
  },
  diskRead: {
    icon: HardDriveDownload,
    group: "system",
    labelKey: "terminalStatusBar.item.diskRead",
    descriptionKey: "terminalStatusBar.item.diskRead.description",
    sample: "R 12 MB/s",
  },
  diskWrite: {
    icon: HardDriveUpload,
    group: "system",
    labelKey: "terminalStatusBar.item.diskWrite",
    descriptionKey: "terminalStatusBar.item.diskWrite.description",
    sample: "W 3.2 MB/s",
  },
};

const TOKEN_ITEM_KEYS: readonly TerminalStatusBarItemKey[] = ["todayTokens", "todayCost", "claudeTokens", "codexTokens"];
const SESSION_COUNT_ITEM_KEYS: readonly TerminalStatusBarItemKey[] = ["aiRunning", "aiAttention"];

/** 根据可见项推导需要启用的数据源，未显示的数据源不轮询。 */
export function resolveTerminalStatusBarDataNeeds(visibleKeys: readonly TerminalStatusBarItemKey[]) {
  const visible = new Set(visibleKeys);
  return {
    tokens: TOKEN_ITEM_KEYS.some((key) => visible.has(key)),
    sessionCounts: SESSION_COUNT_ITEM_KEYS.some((key) => visible.has(key)),
    cpu: visible.has("cpu"),
    memory: visible.has("memory"),
    appMemory: visible.has("appMemory"),
    gpu: visible.has("gpu") || visible.has("vram"),
    network: visible.has("netUp") || visible.has("netDown"),
    disk: visible.has("diskRead") || visible.has("diskWrite"),
  };
}

export function formatStatusBarBytes(bytes: number): string {
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

export function formatStatusBarRate(bytesPerSecond: number): string {
  return `${formatStatusBarBytes(bytesPerSecond)}/s`;
}

export function formatStatusBarPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(Math.min(100, Math.max(0, value)))}%`;
}
