import type { TranslationKey } from "./i18n";

const PI_EXTENSION_CONFLICT_ERROR = "pi_extension_conflict";

type Translate = (key: TranslationKey) => string;

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getPiHookErrorMessage(error: unknown, t: Translate): string {
  const message = getErrorMessage(error);
  return message === PI_EXTENSION_CONFLICT_ERROR
    ? t("settings.hooks.pi.extensionConflict")
    : message;
}
