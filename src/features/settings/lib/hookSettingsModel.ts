import { pickByLanguage, type AppLanguage, type TranslationKey } from "../../../shared/i18n/index";

export type HookInstallStatus = "directoryMissing" | "notInstalled" | "partialInstalled" | "installed" | "unsupported";

export type HookBridgeBadgeStatus = HookInstallStatus | "conflict" | "pending" | "error";

export type HookTool = "claude" | "codex" | "kimi" | "pi" | "grok";

export type HookModule = "sessionStart" | "running" | "attention" | "stop" | "failure" | "subagent" | "hooksFeature";

export interface ToolHookSettingsStatus {
  configDir: string | null;
  hooksDir: string | null;
  configPath: string | null;
  featureConfigPath: string | null;
  effectiveConfigPath?: string | null;
  hooksTrusted?: boolean;
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

export const BADGE_STATUS_LABELS: Record<HookBridgeBadgeStatus, { zh: string; en: string }> = {
  ...STATUS_LABELS,
  conflict: { zh: "配置冲突", en: "Config Conflict" },
  pending: { zh: "检测中…", en: "Checking…" },
  error: { zh: "读取失败", en: "Read Failed" },
};

export const BADGE_STATUS_COLORS: Record<HookBridgeBadgeStatus, string> = {
  ...STATUS_COLORS,
  conflict: "red",
  pending: "gray",
  error: "red",
};

export function getBadgeStatusLabel(status: HookBridgeBadgeStatus, language: AppLanguage): string {
  const entry = BADGE_STATUS_LABELS[status];
  return pickByLanguage(language, entry.zh, entry.en);
}

export function getBadgeStatusColor(status: HookBridgeBadgeStatus): string {
  return BADGE_STATUS_COLORS[status];
}

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

export function getNotificationSoundErrorDescription(error: unknown, t: (key: TranslationKey) => string): string {
  switch (getNotificationSoundErrorCode(error)) {
    case "notification_sound_format_unsupported":
    case "notification_sound_invalid_wave":
      return t("settings.hooks.systemNotifications.sound.invalidFormat");
    case "notification_sound_unavailable":
    case "notification_sound_not_file":
      return t("settings.hooks.systemNotifications.sound.unavailable");
    case "notification_sound_too_large":
      return t("settings.hooks.systemNotifications.sound.tooLarge");
    case "notification_sound_path_empty":
    case "notification_sound_path_contains_nul":
    case "notification_sound_path_too_long":
      return t("settings.hooks.systemNotifications.sound.invalidPath");
    default:
      return t("settings.hooks.systemNotifications.sound.operationFailed");
  }
}
