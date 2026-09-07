import type { NativeProviderAppType } from "./nativeProviderTypes";

export type NativeProviderWireApi = "responses" | "chat_completions" | "anthropic_messages";

export interface NativeProviderModelMapping {
  source: string;
  target: string;
}

export interface NativeProviderAdvancedConfig {
  wireApi: NativeProviderWireApi;
  modelMappings: NativeProviderModelMapping[];
  userAgent: string;
  headerOverride: string;
  bodyOverride: string;
  goalMode: boolean;
  remoteCompression: boolean;
}

export interface NativeProviderConfigSeed {
  baseUrl?: string;
  model?: string;
  apiFormat?: string;
  claude?: {
    apiFormat: string;
    model: string;
    defaultHaikuModel: string;
    defaultHaikuModelName: string;
    defaultSonnetModel: string;
    defaultSonnetModelName: string;
    defaultOpusModel: string;
    defaultOpusModelName: string;
    defaultFableModel: string;
    defaultFableModelName: string;
    subagentModel: string;
  };
}

const DEFAULT_ADVANCED_CONFIG: NativeProviderAdvancedConfig = {
  wireApi: "responses",
  modelMappings: [],
  userAgent: "",
  headerOverride: "{}",
  bodyOverride: "{}",
  goalMode: false,
  remoteCompression: false,
};

export function defaultNativeProviderAdvancedConfig(): NativeProviderAdvancedConfig {
  return {
    ...DEFAULT_ADVANCED_CONFIG,
    modelMappings: [],
  };
}

export function normalizeNativeProviderWireApi(value: string | null | undefined): NativeProviderWireApi {
  if (value === "chat_completions" || value === "chat" || value === "openai_chat") return "chat_completions";
  if (value === "anthropic_messages" || value === "anthropic") return "anthropic_messages";
  if (value === "openai_responses") return "responses";
  return "responses";
}

export function nativeProviderAdvancedConfigFromSettings(
  settingsConfig: string,
  fallbackWireApi?: string | null,
): NativeProviderAdvancedConfig {
  let advanced: Partial<NativeProviderAdvancedConfig> = {};
  try {
    const parsed: unknown = JSON.parse(settingsConfig);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const candidate = (parsed as { advanced?: unknown }).advanced;
      if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
        advanced = candidate as Partial<NativeProviderAdvancedConfig>;
      }
    }
  } catch {
    // The backend reports malformed documents. Keep the form usable for repair.
  }
  const mappings = Array.isArray(advanced.modelMappings)
    ? advanced.modelMappings
      .filter((item): item is NativeProviderModelMapping => (
        typeof item === "object"
        && item !== null
        && typeof (item as NativeProviderModelMapping).source === "string"
        && typeof (item as NativeProviderModelMapping).target === "string"
      ))
      .map((item) => ({ source: item.source, target: item.target }))
    : [];
  return {
    ...defaultNativeProviderAdvancedConfig(),
    ...advanced,
    wireApi: normalizeNativeProviderWireApi(advanced.wireApi ?? fallbackWireApi),
    modelMappings: mappings,
    userAgent: typeof advanced.userAgent === "string" ? advanced.userAgent : "",
    headerOverride: typeof advanced.headerOverride === "string" ? advanced.headerOverride : "{}",
    bodyOverride: typeof advanced.bodyOverride === "string" ? advanced.bodyOverride : "{}",
    goalMode: advanced.goalMode === true,
    remoteCompression: advanced.remoteCompression === true,
  };
}

export function settingsConfigWithAdvanced(
  settingsConfig: string,
  advanced: NativeProviderAdvancedConfig,
): string {
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(settingsConfig);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      settings = { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    settings = {};
  }
  settings.advanced = advanced;
  return JSON.stringify(settings);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function generateClaudeConfig(seed: NativeProviderConfigSeed): string {
  const claude = seed.claude;
  const env: Record<string, string> = {};
  const baseUrl = nonEmpty(seed.baseUrl);
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  const model = nonEmpty(claude?.model ?? seed.model);
  if (model) env.ANTHROPIC_MODEL = model;
  for (const [key, value] of [
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL", claude?.defaultHaikuModel],
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", claude?.defaultHaikuModelName],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", claude?.defaultSonnetModel],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", claude?.defaultSonnetModelName],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", claude?.defaultOpusModel],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", claude?.defaultOpusModelName],
    ["ANTHROPIC_DEFAULT_FABLE_MODEL", claude?.defaultFableModel],
    ["ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", claude?.defaultFableModelName],
    ["CLAUDE_CODE_SUBAGENT_MODEL", claude?.subagentModel],
  ] as const) {
    const text = nonEmpty(value);
    if (text) env[key] = text;
  }
  const document: Record<string, unknown> = { env };
  if (claude?.apiFormat || seed.apiFormat) document.api_format = claude?.apiFormat ?? seed.apiFormat;
  return JSON.stringify(document, null, 2);
}

function generateCodexConfig(seed: NativeProviderConfigSeed, advanced: NativeProviderAdvancedConfig): string {
  const lines = [
    "model_provider = \"custom\"",
  ];
  const model = nonEmpty(seed.model);
  if (model) lines.push(`model = ${tomlString(model)}`);
  lines.push("", "[model_providers.custom]", "name = \"custom\"", `wire_api = ${tomlString(advanced.wireApi)}`, "requires_openai_auth = true");
  const baseUrl = nonEmpty(seed.baseUrl);
  if (baseUrl) lines.push(`base_url = ${tomlString(baseUrl)}`);
  return `${lines.join("\n")}\n`;
}

function generateGrokConfig(seed: NativeProviderConfigSeed, advanced: NativeProviderAdvancedConfig): string {
  const model = nonEmpty(seed.model);
  const baseUrl = nonEmpty(seed.baseUrl);
  const lines = [
    "[models]",
    "default = \"custom\"",
    "",
    "[model.custom]",
    "name = \"custom\"",
    `api_backend = ${tomlString(advanced.wireApi)}`,
    "context_window = 500000",
  ];
  if (model) lines.push(`model = ${tomlString(model)}`);
  if (baseUrl) lines.push(`base_url = ${tomlString(baseUrl)}`);
  return `${lines.join("\n")}\n`;
}

export function generateNativeProviderConfigDocument(
  appType: NativeProviderAppType,
  seed: NativeProviderConfigSeed,
  advanced = defaultNativeProviderAdvancedConfig(),
): string {
  if (appType === "claude") return generateClaudeConfig(seed);
  if (appType === "codex") return generateCodexConfig(seed, advanced);
  return generateGrokConfig(seed, advanced);
}

export function isEmptyNativeProviderConfigDocument(appType: NativeProviderAppType, value: string): boolean {
  if (appType !== "claude") return value.trim().length === 0;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      && Object.keys(parsed).length === 0;
  } catch {
    return value.trim().length === 0;
  }
}

export function isValidNativeProviderAdvancedConfig(value: NativeProviderAdvancedConfig): boolean {
  const isObjectDocument = (document: string): boolean => {
    try {
      const parsed: unknown = JSON.parse(document);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  };
  return isObjectDocument(value.headerOverride)
    && isObjectDocument(value.bodyOverride)
    && value.modelMappings.every((item) => item.source.trim() && item.target.trim());
}
