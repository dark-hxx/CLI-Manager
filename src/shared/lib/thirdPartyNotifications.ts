import type { HookEventType } from "../preferences/settingsStore";

export const THIRD_PARTY_NOTIFICATION_PROVIDERS = [
  "dingtalk",
  "feishu",
  "wecom",
  "bark",
  "pushplus",
  "wxpusher",
  "serverchan",
  "telegram",
  "ntfy",
  "gotify",
  "custom",
] as const;

export type ThirdPartyNotificationProvider = typeof THIRD_PARTY_NOTIFICATION_PROVIDERS[number];

export interface ThirdPartyHookTarget {
  id: string;
  name: string;
  provider: ThirdPartyNotificationProvider;
  enabled: boolean;
  events: Record<HookEventType, boolean>;
  config: Record<string, unknown>;
}

export const THIRD_PARTY_HOOK_TARGET_LIMIT = 20;

export const DEFAULT_THIRD_PARTY_EVENTS: Record<HookEventType, boolean> = {
  SessionStart: false,
  UserPromptSubmit: false,
  Notification: true,
  Stop: true,
  StopFailure: true,
  PermissionRequest: true,
};

export function isThirdPartyNotificationProvider(value: unknown): value is ThirdPartyNotificationProvider {
  return typeof value === "string" && THIRD_PARTY_NOTIFICATION_PROVIDERS.includes(value as ThirdPartyNotificationProvider);
}

export function createThirdPartyHookTarget(provider: ThirdPartyNotificationProvider): ThirdPartyHookTarget {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `target-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    name: defaultTargetName(provider),
    provider,
    enabled: true,
    events: { ...DEFAULT_THIRD_PARTY_EVENTS },
    config: defaultConfig(provider),
  };
}

export function sanitizeThirdPartyHookTargets(value: unknown): ThirdPartyHookTarget[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: ThirdPartyHookTarget[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (!isThirdPartyNotificationProvider(raw.provider)) continue;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : defaultTargetName(raw.provider),
      provider: raw.provider,
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      events: sanitizeEvents(raw.events),
      config: sanitizeConfig(raw.config),
    });
    if (result.length >= THIRD_PARTY_HOOK_TARGET_LIMIT) break;
  }
  return result;
}

function sanitizeEvents(value: unknown): Record<HookEventType, boolean> {
  const raw = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    SessionStart: typeof raw.SessionStart === "boolean" ? raw.SessionStart : DEFAULT_THIRD_PARTY_EVENTS.SessionStart,
    UserPromptSubmit: typeof raw.UserPromptSubmit === "boolean" ? raw.UserPromptSubmit : DEFAULT_THIRD_PARTY_EVENTS.UserPromptSubmit,
    Notification: typeof raw.Notification === "boolean" ? raw.Notification : DEFAULT_THIRD_PARTY_EVENTS.Notification,
    Stop: typeof raw.Stop === "boolean" ? raw.Stop : DEFAULT_THIRD_PARTY_EVENTS.Stop,
    StopFailure: typeof raw.StopFailure === "boolean" ? raw.StopFailure : DEFAULT_THIRD_PARTY_EVENTS.StopFailure,
    PermissionRequest: typeof raw.PermissionRequest === "boolean" ? raw.PermissionRequest : DEFAULT_THIRD_PARTY_EVENTS.PermissionRequest,
  };
}

function sanitizeConfig(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function defaultTargetName(provider: ThirdPartyNotificationProvider): string {
  return PROVIDER_NAMES[provider];
}

function defaultConfig(provider: ThirdPartyNotificationProvider): Record<string, unknown> {
  if (provider === "ntfy") return { serverUrl: "https://ntfy.sh", authType: "none" };
  if (provider === "bark") return { serverUrl: "https://api.day.app" };
  if (provider === "pushplus") return { template: "txt" };
  if (provider === "custom") {
    return {
      method: "POST",
      url: "",
      bodyType: "json",
      jsonBody: { title: "{{title}}", body: "{{body}}", event: "{{event}}" },
    };
  }
  return {};
}

export const PROVIDER_NAMES: Record<ThirdPartyNotificationProvider, string> = {
  dingtalk: "DingTalk",
  feishu: "Feishu",
  wecom: "WeCom",
  bark: "Bark",
  pushplus: "PushPlus",
  wxpusher: "WxPusher",
  serverchan: "ServerChan",
  telegram: "Telegram",
  ntfy: "ntfy",
  gotify: "Gotify",
  custom: "Custom HTTP",
};
