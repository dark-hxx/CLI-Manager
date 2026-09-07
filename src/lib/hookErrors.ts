import type { TranslationKey } from "./i18n";

const PI_EXTENSION_CONFLICT_ERROR = "pi_extension_conflict";
const KIMI_HOOK_ERROR_KEYS = {
  kimi_code_unsupported: "settings.hooks.kimi.unsupported",
  hook_config_doctor_failed: "settings.hooks.kimi.doctorFailed",
  hook_config_toml_invalid: "settings.hooks.kimi.tomlInvalid",
  hook_config_toml_hooks_invalid: "settings.hooks.kimi.tomlInvalid",
  hook_config_owner_conflict: "settings.hooks.kimi.ownerConflict",
  kimi_config_dir_required: "settings.hooks.kimi.configDirRequired",
  kimi_config_dir_missing: "settings.hooks.kimi.configDirMissing",
  kimi_config_dir_create_failed: "settings.hooks.kimi.configDirCreateFailed",
} as const satisfies Record<string, TranslationKey>;

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

export function getKimiHookErrorMessage(error: unknown, t: Translate): string {
  const message = getErrorMessage(error);
  for (const [code, key] of Object.entries(KIMI_HOOK_ERROR_KEYS)) {
    if (message === code) return t(key);
    if (message.startsWith(`${code}: `)) {
      return `${t(key)} ${message.slice(code.length + 2)}`;
    }
  }
  return message;
}
