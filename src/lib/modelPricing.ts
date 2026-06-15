// 模型定价表（与 src-tauri/src/commands/history.rs 的 HISTORY_MODEL_PRICING 保持同步）
interface ModelPricing {
  modelId: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheCreationPerMillion: number;
}

const MODEL_PRICING: ModelPricing[] = [
  { modelId: "claude-opus-4-8", inputPerMillion: 15.0, outputPerMillion: 75.0, cacheReadPerMillion: 1.5, cacheCreationPerMillion: 18.75 },
  { modelId: "claude-opus-4-7", inputPerMillion: 15.0, outputPerMillion: 75.0, cacheReadPerMillion: 1.5, cacheCreationPerMillion: 18.75 },
  { modelId: "claude-opus-4-6", inputPerMillion: 15.0, outputPerMillion: 75.0, cacheReadPerMillion: 1.5, cacheCreationPerMillion: 18.75 },
  { modelId: "claude-opus-4-1", inputPerMillion: 15.0, outputPerMillion: 75.0, cacheReadPerMillion: 1.5, cacheCreationPerMillion: 18.75 },
  { modelId: "claude-opus-4", inputPerMillion: 15.0, outputPerMillion: 75.0, cacheReadPerMillion: 1.5, cacheCreationPerMillion: 18.75 },
  { modelId: "claude-sonnet-4-6", inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3, cacheCreationPerMillion: 3.75 },
  { modelId: "claude-sonnet-4-5", inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3, cacheCreationPerMillion: 3.75 },
  { modelId: "claude-sonnet-4-2", inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3, cacheCreationPerMillion: 3.75 },
  { modelId: "claude-sonnet-4", inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3, cacheCreationPerMillion: 3.75 },
  { modelId: "claude-haiku-4-5", inputPerMillion: 0.8, outputPerMillion: 4.0, cacheReadPerMillion: 0.08, cacheCreationPerMillion: 1.0 },
  { modelId: "claude-haiku-4-2", inputPerMillion: 0.8, outputPerMillion: 4.0, cacheReadPerMillion: 0.08, cacheCreationPerMillion: 1.0 },
  { modelId: "claude-haiku-4", inputPerMillion: 0.8, outputPerMillion: 4.0, cacheReadPerMillion: 0.08, cacheCreationPerMillion: 1.0 },
  { modelId: "claude-fable-5", inputPerMillion: 15.0, outputPerMillion: 75.0, cacheReadPerMillion: 1.5, cacheCreationPerMillion: 18.75 },
  { modelId: "claude-3-5-sonnet-20241022", inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3, cacheCreationPerMillion: 3.75 },
  { modelId: "claude-3-5-sonnet-20240620", inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3, cacheCreationPerMillion: 3.75 },
  { modelId: "claude-3-5-haiku-20241022", inputPerMillion: 0.8, outputPerMillion: 4.0, cacheReadPerMillion: 0.08, cacheCreationPerMillion: 1.0 },
  { modelId: "claude-3-opus-20240229", inputPerMillion: 15.0, outputPerMillion: 75.0, cacheReadPerMillion: 1.5, cacheCreationPerMillion: 18.75 },
  { modelId: "claude-3-sonnet-20240229", inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3, cacheCreationPerMillion: 3.75 },
  { modelId: "claude-3-haiku-20240307", inputPerMillion: 0.25, outputPerMillion: 1.25, cacheReadPerMillion: 0.03, cacheCreationPerMillion: 0.3 },
  { modelId: "o4", inputPerMillion: 2.5, outputPerMillion: 10.0, cacheReadPerMillion: 0.625, cacheCreationPerMillion: 0.0 },
  { modelId: "o4-mini", inputPerMillion: 1.1, outputPerMillion: 4.4, cacheReadPerMillion: 0.275, cacheCreationPerMillion: 0.0 },
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

function normalizeModelId(model: string): string | null {
  const lower = model.toLowerCase().trim();

  // 移除 UI 展示用后缀，如 "(xhigh)" / " (high)"
  const withoutEffort = lower.replace(/\s*\([^)]*\)$/, "");

  // 移除 [1m] 后缀
  const withoutSuffix = withoutEffort.replace(/\[1m\]$/, "");

  // 移除 us.anthropic.com/ 或 us.anthropic. 前缀
  const withoutRegion = withoutSuffix
    .replace(/^us\.anthropic\.com\//, "")
    .replace(/^us\.anthropic\./, "");

  // 移除 anthropic. 前缀
  const withoutVendor = withoutRegion.replace(/^anthropic\./, "");

  if (withoutVendor.length === 0) return null;
  return withoutVendor;
}

function findModelPricing(model: string): ModelPricing | null {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;

  // 精确匹配
  const exact = MODEL_PRICING.find((p) => normalized === p.modelId);
  if (exact) return exact;

  // 前缀匹配（例如 "claude-opus-4-8-20260101" 匹配 "claude-opus-4-8"）
  const prefixMatches = MODEL_PRICING.filter(
    (p) => normalized.startsWith(p.modelId) && normalized[p.modelId.length] === "-"
  );

  // 返回最长匹配
  if (prefixMatches.length > 0) {
    return prefixMatches.reduce((longest, current) =>
      current.modelId.length > longest.modelId.length ? current : longest
    );
  }

  return null;
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

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheCreationCost = (cacheCreationTokens / 1_000_000) * pricing.cacheCreationPerMillion;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion;

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
  if (!model) return null;
  // "[1m]" 后缀标记 1M 上下文窗口的模型变体（如 claude-sonnet-4-5[1m]）
  if (/\[1m\]/i.test(model)) return 1_000_000;
  const normalized = normalizeModelId(model);
  if (!normalized) return null;

  // 精确匹配
  if (normalized in MODEL_CONTEXT_LIMITS) {
    return MODEL_CONTEXT_LIMITS[normalized];
  }

  // 前缀匹配
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (normalized.startsWith(key) && normalized[key.length] === "-") {
      return limit;
    }
  }

  return null;
}
