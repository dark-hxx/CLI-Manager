import type { NativeProviderAppType } from "./nativeProviderTypes";
import {
  generateNativeProviderConfigDocument,
  type NativeProviderAdvancedConfig,
  type NativeProviderConfigSeed,
} from "./nativeProviderAdvancedConfig";

export type NativeProviderConfigFormat = "json" | "toml";

export function nativeProviderConfigFormat(appType: NativeProviderAppType): NativeProviderConfigFormat {
  return appType === "claude" ? "json" : "toml";
}

export function nativeProviderConfigKind(appType: NativeProviderAppType): string {
  if (appType === "claude") return "claude.settings";
  if (appType === "codex") return "codex.config";
  return "grokbuild.config";
}

export function formatJsonDocument(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function providerConfigDocumentFromSettings(
  appType: NativeProviderAppType,
  settingsConfig: string,
  seed?: NativeProviderConfigSeed,
  advanced?: NativeProviderAdvancedConfig,
): string {
  if (appType === "claude") {
    const formatted = formatJsonDocument(settingsConfig);
    return seed && isEmptyJsonDocument(formatted)
      ? generateNativeProviderConfigDocument(appType, seed, advanced)
      : formatted;
  }
  try {
    const parsed: unknown = JSON.parse(settingsConfig);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const config = (parsed as { config?: unknown }).config;
      if (typeof config === "string" && config.trim()) return config;
    }
  } catch {
    return seed ? generateNativeProviderConfigDocument(appType, seed, advanced) : settingsConfig;
  }
  return seed ? generateNativeProviderConfigDocument(appType, seed, advanced) : "";
}

function isEmptyJsonDocument(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

export function settingsConfigFromProviderDocument(
  appType: NativeProviderAppType,
  document: string,
  existingSettingsConfig?: string,
): string {
  if (appType === "claude") return document;
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(existingSettingsConfig ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      settings = { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    settings = {};
  }
  settings.config = document;
  return JSON.stringify(settings);
}

export function isValidProviderConfigDocument(
  appType: NativeProviderAppType,
  value: string,
): boolean {
  if (nativeProviderConfigFormat(appType) === "toml") return true;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
