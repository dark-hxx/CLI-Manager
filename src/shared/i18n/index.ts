import { zh, en } from "./catalogs";
import OpenCC from "opencc-js";
import { useMemo } from "react";
import { useSettingsStore, type LanguagePreference } from "../preferences/settingsStore";

export type AppLanguage = "zh-CN" | "zh-TW" | "en-US";

export const LANGUAGE_OPTIONS: { value: LanguagePreference; label: string }[] = [
  { value: "auto", label: "Auto / 自动" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en-US", label: "English" },
];

const TRADITIONAL_ZH_PREFIXES = ["zh-tw", "zh-hk", "zh-mo", "zh-hant"];
const SIMPLIFIED_ZH_PREFIXES = ["zh", "zh-cn", "zh-hans", "zh-sg", "zh-my"];

export function detectPreferredLanguage(): AppLanguage {
  const candidates =
    typeof navigator === "undefined"
      ? []
      : [navigator.language, ...(Array.isArray(navigator.languages) ? navigator.languages : [])];
  const normalized = candidates
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (normalized.some((item) => TRADITIONAL_ZH_PREFIXES.some((prefix) => item === prefix || item.startsWith(`${prefix}-`)))) {
    return "zh-TW";
  }

  if (normalized.some((item) => SIMPLIFIED_ZH_PREFIXES.some((prefix) => item === prefix || item.startsWith(`${prefix}-`)))) {
    return "zh-CN";
  }

  return "en-US";
}

export function resolveLanguagePreference(language: LanguagePreference): AppLanguage {
  return language === "auto" ? detectPreferredLanguage() : language;
}

export function isEnglishLanguage(language: AppLanguage): boolean {
  return language === "en-US";
}

export function isChineseLanguage(language: AppLanguage): boolean {
  return !isEnglishLanguage(language);
}

export function convertChineseForLanguage(language: AppLanguage, text: string): string {
  return language === "zh-TW" ? zhTwConverter(text) : text;
}

export function pickByLanguage<T>(language: AppLanguage, zh: T, en: T): T {
  if (isEnglishLanguage(language)) return en;
  if (typeof zh === "string" && typeof en === "string") {
    return convertChineseForLanguage(language, zh) as T;
  }
  return zh;
}

export function getLanguageLocale(language: AppLanguage, englishLocale = "en-US"): string {
  if (language === "en-US") return englishLocale;
  return language;
}





const zhTwConverter = OpenCC.Converter({ from: "cn", to: "tw" });
const zhTwOverrides: Partial<Record<keyof typeof zh, string>> = {
  "desktopPet.mood.working": "工作中",
};

function buildTraditionalChineseDictionary(
  base: typeof zh,
  overrides: Partial<Record<keyof typeof zh, string>>
): Record<keyof typeof zh, string> {
  const converted = Object.fromEntries(
    Object.entries(base).map(([key, value]) => [key, zhTwConverter(value)])
  ) as Record<keyof typeof zh, string>;
  return { ...converted, ...overrides };
}

const zhTw = buildTraditionalChineseDictionary(zh, zhTwOverrides);

const dictionaries = {
  "zh-CN": zh,
  "zh-TW": zhTw,
  "en-US": en,
};

export type TranslationKey = keyof typeof zh;

function formatTemplate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

export function translate(language: AppLanguage, key: TranslationKey, params?: Record<string, string | number>): string {
  return formatTemplate(dictionaries[language][key] ?? zh[key], params);
}

export function getCurrentLanguage(): AppLanguage {
  return resolveLanguagePreference(useSettingsStore.getState().language);
}

export function translateCurrent(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate(getCurrentLanguage(), key, params);
}

export function useI18n() {
  const languagePreference = useSettingsStore((s) => s.language);
  const language = resolveLanguagePreference(languagePreference);

  return useMemo(
    () => ({
      language,
      t: (key: TranslationKey, params?: Record<string, string | number>) => translate(language, key, params),
    }),
    [language]
  );
}
