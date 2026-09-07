import { pickByLanguage, type AppLanguage } from "@/lib/i18n";

export type HookInstallStatus = "directoryMissing" | "notInstalled" | "partialInstalled" | "installed" | "unsupported";

export type HookTool = "claude" | "codex" | "kimi" | "pi" | "grok";

export type HookModule = "sessionStart" | "running" | "attention" | "stop" | "failure" | "subagent" | "hooksFeature";

export interface ToolHookSettingsStatus {
  configDir: string | null;
  hooksDir: string | null;
  configPath: string | null;
  featureConfigPath: string | null;
  status: HookInstallStatus;
  attentionScriptInstalled: boolean;
  finishedScriptInstalled: boolean;
  sessionStartHookInstalled: boolean;
  runningHookInstalled: boolean;
  attentionHookInstalled: boolean;
  stopHookInstalled: boolean;
  failureHookInstalled: boolean;
  subagentStartHookInstalled: boolean;
  hooksFeatureInstalled: boolean;
}

export interface HookSettingsStatus {
  claude: ToolHookSettingsStatus;
  codex: ToolHookSettingsStatus;
  kimi: ToolHookSettingsStatus;
  pi: ToolHookSettingsStatus;
  grok: ToolHookSettingsStatus;
  claudeAutoRepaired: boolean;
}

export const STATUS_LABELS: Record<HookInstallStatus, { zh: string; en: string }> = {
  directoryMissing: { zh: "目录未选择", en: "Directory Missing" },
  notInstalled: { zh: "未安装", en: "Not Installed" },
  partialInstalled: { zh: "部分安装", en: "Partially Installed" },
  installed: { zh: "已安装", en: "Installed" },
  unsupported: { zh: "版本不支持", en: "Unsupported Version" },
};

export const STATUS_COLORS: Record<HookInstallStatus, string> = {
  directoryMissing: "yellow",
  notInstalled: "gray",
  partialInstalled: "yellow",
  installed: "green",
  unsupported: "red",
};

export function pickText(language: AppLanguage, zh: string, en: string) {
  return pickByLanguage(language, zh, en);
}

export function isWindowsPlatform(): boolean {
  return typeof navigator !== "undefined" && /win/i.test(navigator.platform);
}

export type NotificationSoundStatus = "idle" | "checking" | "valid" | "invalid";

export function getNotificationSoundFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function getNotificationSoundErrorCode(error: unknown): string {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : String(error);
}

export function formatPath(value: string | null, language: AppLanguage): string {
  return value && value.trim() ? value : pickText(language, "未选择", "Not selected");
}
