export type ModelPriceSource = "builtin" | "manual" | "litellm" | "openrouter" | string;

export interface ModelPrice {
  model: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number;
  cacheCreationPer1m: number;
  contextWindow?: number | null;
  source: ModelPriceSource;
  sourceModelId: string | null;
  rawJson: string | null;
  updatedAtMs: number;
  syncedAtMs: number | null;
}

interface ModelPricingLike {
  model: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number;
  cacheCreationPer1m: number;
  contextWindow?: number | null;
  source?: ModelPriceSource;
  rawJson?: string | null;
}

interface ModelPriceProviderState {
  prices: Record<string, ModelPrice>;
  authoritative: boolean;
}

let modelPriceProvider: (() => ModelPriceProviderState) | null = null;

export function registerModelPriceProvider(provider: () => ModelPriceProviderState): void {
  modelPriceProvider = provider;
}

function seed(model: string, inputPer1m: number, outputPer1m: number, cacheReadPer1m: number, cacheCreationPer1m: number): ModelPrice {
  return {
    model,
    inputPer1m,
    outputPer1m,
    cacheReadPer1m,
    cacheCreationPer1m,
    contextWindow: null,
    source: "builtin",
    sourceModelId: model,
    rawJson: null,
    updatedAtMs: 0,
    syncedAtMs: null,
  };
}

// DEPRECATED: seed/fallback only; SQLite model_prices is authoritative after store load.
export const DEFAULT_MODEL_PRICES: ModelPrice[] = [
  seed("claude-opus-4-8", 15.0, 75.0, 1.5, 18.75),
  seed("claude-opus-4-7", 15.0, 75.0, 1.5, 18.75),
  seed("claude-opus-4-6", 15.0, 75.0, 1.5, 18.75),
  seed("claude-opus-4-1", 15.0, 75.0, 1.5, 18.75),
  seed("claude-opus-4", 15.0, 75.0, 1.5, 18.75),
  seed("claude-sonnet-4-6", 3.0, 15.0, 0.3, 3.75),
  seed("claude-sonnet-4-5", 3.0, 15.0, 0.3, 3.75),
  seed("claude-sonnet-4-2", 3.0, 15.0, 0.3, 3.75),
  seed("claude-sonnet-4", 3.0, 15.0, 0.3, 3.75),
  seed("claude-haiku-4-5", 0.8, 4.0, 0.08, 1.0),
  seed("claude-haiku-4-2", 0.8, 4.0, 0.08, 1.0),
  seed("claude-haiku-4", 0.8, 4.0, 0.08, 1.0),
  seed("claude-fable-5", 15.0, 75.0, 1.5, 18.75),
  seed("claude-3-7-sonnet", 3.0, 15.0, 0.3, 3.75),
  seed("claude-3-5-sonnet", 3.0, 15.0, 0.3, 3.75),
  seed("claude-3-5-sonnet-20241022", 3.0, 15.0, 0.3, 3.75),
  seed("claude-3-5-sonnet-20240620", 3.0, 15.0, 0.3, 3.75),
  seed("claude-3-5-haiku", 0.8, 4.0, 0.08, 1.0),
  seed("claude-3-5-haiku-20241022", 0.8, 4.0, 0.08, 1.0),
  seed("claude-3-opus", 15.0, 75.0, 1.5, 18.75),
  seed("claude-3-opus-20240229", 15.0, 75.0, 1.5, 18.75),
  seed("claude-3-sonnet", 3.0, 15.0, 0.3, 3.75),
  seed("claude-3-sonnet-20240229", 3.0, 15.0, 0.3, 3.75),
  seed("claude-3-haiku", 0.25, 1.25, 0.03, 0.3),
  seed("claude-3-haiku-20240307", 0.25, 1.25, 0.03, 0.3),
  seed("gpt-5", 1.25, 10.0, 0.125, 0.0),
  seed("gpt-5-mini", 0.25, 2.0, 0.025, 0.0),
  seed("gpt-5-nano", 0.05, 0.4, 0.005, 0.0),
  seed("gpt-4-1", 2.0, 8.0, 0.5, 0.0),
  seed("gpt-4-1-mini", 0.4, 1.6, 0.1, 0.0),
  seed("gpt-4o", 2.5, 10.0, 1.25, 0.0),
  seed("gpt-4o-mini", 0.15, 0.6, 0.075, 0.0),
  seed("o3", 2.0, 8.0, 0.5, 0.0),
  seed("o3-mini", 0.55, 2.2, 0.55, 0.0),
  seed("o4", 2.5, 10.0, 0.625, 0.0),
  seed("o4-mini", 1.1, 4.4, 0.275, 0.0),
];

// 模型上下文窗口映射表（单位：tokens）。优先使用日志中携带的精确 context_window，缺失时才回退到这里。
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-1": 200_000,
  "claude-opus-4": 200_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-2": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-2": 200_000,
  "claude-haiku-4": 200_000,
  "claude-fable-5": 1_000_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-sonnet-20240620": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
  "claude-3-sonnet-20240229": 200_000,
  "claude-3-haiku-20240307": 200_000,
  "o4": 200_000,
  "o4-mini": 128_000,
};

const LITELLM_CONTEXT_KEYS = ["max_input_tokens", "context_window", "max_tokens"] as const;
const OPENROUTER_CONTEXT_KEYS = ["context_length"] as const;
const GENERIC_CONTEXT_KEYS = [
  "model_context_window",
  "context_window",
  "contextWindow",
  "max_context_tokens",
  "maxContextTokens",
  "max_input_tokens",
  "maxInputTokens",
  "context_length",
  "contextLength",
  "max_tokens",
  "maxTokens",
] as const;

const REASONING_EFFORT_SUFFIXES = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function normalizeReasoningEffortKey(value: string): string | null {
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return REASONING_EFFORT_SUFFIXES.has(key) ? key : null;
}

function normalizeReasoningEffortSuffix(value: string): string {
  const match = value.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (!match) return value;

  const base = match[1].trim();
  const effort = normalizeReasoningEffortKey(match[2]);
  if (!effort) return base;
  return base ? `${base}-${effort}` : value;
}

export function normalizeModelId(model: string): string | null {
  let value = model.toLowerCase().trim();
  value = value.replace(/\[1m\]$/, "");
  value = normalizeReasoningEffortSuffix(value);
  value = value.replace(/^us\.anthropic\.com\//, "").replace(/^us\.anthropic\./, "");
  if (value.includes("/")) value = value.split("/").pop() ?? value;
  if (value.includes(":")) value = value.split(":")[0] ?? value;
  value = value.replace(/^anthropic\./, "").replace(/^anthropic-/, "").replace(/^global-anthropic-/, "");
  value = value.replace(/@/g, "-").replace(/\./g, "-");
  const dated = value.match(/^(.*)-\d{4}-\d{2}-\d{2}$/);
  if (dated) value = dated[1];
  if (value.endsWith("-v1")) value = value.slice(0, -3);
  if (value.length === 0 || value === "unknown") return null;
  return value;
}

export function findModelPricing(model: string): ModelPricingLike | null {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;

  const providerState = modelPriceProvider?.();
  const activePrices = providerState?.authoritative ? Object.values(providerState.prices) : DEFAULT_MODEL_PRICES;

  const exact = activePrices.find((p) => normalizeModelId(p.model) === normalized);
  if (exact) return exact;

  const prefixMatches = activePrices.filter((p) => {
    const key = normalizeModelId(p.model);
    return key ? isPricingVariantOf(normalized, key) : false;
  });

  if (prefixMatches.length > 0) {
    return prefixMatches.reduce((longest, current) =>
      current.model.length > longest.model.length ? current : longest
    );
  }

  return null;
}

function isPricingVariantOf(normalizedModel: string, normalizedPricingKey: string): boolean {
  if (!normalizedModel.startsWith(normalizedPricingKey) || normalizedModel[normalizedPricingKey.length] !== "-") {
    return false;
  }
  const suffix = normalizedModel.slice(normalizedPricingKey.length + 1);
  return /^\d{8}$/.test(suffix) || /^\d{4}-\d{2}-\d{2}$/.test(suffix) || /^v\d+$/i.test(suffix) || suffix === "latest";
}

export function normalizeContextLimit(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  }
  return null;
}

function contextKeysForSource(source: ModelPriceSource | null | undefined): readonly string[] {
  if (source === "litellm") return LITELLM_CONTEXT_KEYS;
  if (source === "openrouter") return OPENROUTER_CONTEXT_KEYS;
  return GENERIC_CONTEXT_KEYS;
}

function readContextLimit(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const limit = normalizeContextLimit(record[key]);
    if (limit !== null) return limit;
  }
  return null;
}

function extractTierCutoffContextLimit(record: Record<string, unknown>): number | null {
  let cutoff: number | null = null;
  for (const key of Object.keys(record)) {
    const match = key.match(/_above_(\d+)k_tokens(?:_|$)/);
    if (!match) continue;
    const value = Number(match[1]) * 1_000;
    if (Number.isFinite(value) && value > 0) {
      cutoff = cutoff === null ? value : Math.min(cutoff, value);
    }
  }
  return cutoff;
}

export function extractModelContextWindow(rawJson: string | null | undefined, source?: ModelPriceSource): number | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (source === "litellm") {
      const tierCutoff = extractTierCutoffContextLimit(record);
      if (tierCutoff !== null) return tierCutoff;
    }
    return readContextLimit(record, contextKeysForSource(source)) ?? readContextLimit(record, GENERIC_CONTEXT_KEYS);
  } catch {
    return null;
  }
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  model: string | null
): number {
  if (!model) return 0;

  const pricing = findModelPricing(model);
  if (!pricing) return 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1m;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1m;
  const cacheCreationCost = (cacheCreationTokens / 1_000_000) * pricing.cacheCreationPer1m;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheReadPer1m;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

export function inferDominantModel(messages: { model?: string }[]): string | null {
  const hits = new Map<string, number>();
  for (const msg of messages) {
    const model = msg.model?.trim();
    if (!model || model === "<synthetic>") continue;
    hits.set(model, (hits.get(model) ?? 0) + 1);
  }
  let dominant: string | null = null;
  let maxHits = 0;
  for (const [model, count] of hits) {
    if (count > maxHits) {
      dominant = model;
      maxHits = count;
    }
  }
  return dominant;
}

export function getContextLimit(model: string | null): number | null {
  return resolveContextLimit(model);
}

function getLocalContextLimit(model: string | null): number | null {
  if (!model) return null;
  if (/\[1m\]/i.test(model)) return 1_000_000;
  const normalized = normalizeModelId(model);
  if (!normalized) return null;

  if (normalized in MODEL_CONTEXT_LIMITS) {
    return MODEL_CONTEXT_LIMITS[normalized];
  }

  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (normalized.startsWith(key) && normalized[key.length] === "-") {
      return limit;
    }
  }

  return null;
}

export function resolveContextLimit(model: string | null, exactLimit?: number | null): number | null {
  const exact = normalizeContextLimit(exactLimit);
  if (exact !== null) return exact;

  const pricing = model ? findModelPricing(model) : null;
  const metadataLimit =
    extractModelContextWindow(pricing?.rawJson, pricing?.source)
    ?? normalizeContextLimit(pricing?.contextWindow);
  if (metadataLimit !== null) return metadataLimit;

  return getLocalContextLimit(model);
}
