import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { getDb } from "../../../shared/platform/db";
import {
  DEFAULT_MODEL_PRICES,
  extractModelContextWindow,
  normalizeContextLimit,
  normalizeModelId,
  registerModelPriceProvider,
  type ModelPrice,
} from "./modelPricing";
import { logWarn } from "../../../shared/platform/logger";
import { fetchDiscoveredModels } from "../../history/index";

export interface RemoteModelPrice {
  model: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number;
  cacheCreationPer1m: number;
  contextWindow?: number | null;
  source: "litellm" | "openrouter" | string;
  sourceModelId: string;
  rawJson: string;
}

export interface ModelPriceSyncCandidate {
  targetModel: string;
  score: number;
  remote: RemoteModelPrice;
}

export interface ModelPriceSyncMatch {
  targetModel: string;
  score: number;
  remote: RemoteModelPrice;
}

export interface ModelPriceSyncResult {
  matched: ModelPriceSyncMatch[];
  candidates: ModelPriceSyncCandidate[];
  unmatched: string[];
  fetchedCount: number;
}

interface ModelPriceRow {
  model: string;
  input_per_1m: number;
  output_per_1m: number;
  cache_read_per_1m: number;
  cache_creation_per_1m: number;
  source: string;
  source_model_id: string | null;
  raw_json: string | null;
  updated_at_ms: number;
  synced_at_ms: number | null;
}

interface BackendModelPriceEntry {
  model: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number;
  cacheCreationPer1m: number;
  source: string;
  sourceModelId: string | null;
  rawJson: string | null;
  updatedAtMs: number;
  syncedAtMs: number | null;
}

interface ModelPricingStore {
  modelPrices: Record<string, ModelPrice>;
  discoveredModels: string[];
  candidates: ModelPriceSyncCandidate[];
  unmatchedModels: string[];
  loaded: boolean;
  priceTableReady: boolean;
  loading: boolean;
  syncing: boolean;
  discovering: boolean;
  error: string | null;
  lastSyncResult: ModelPriceSyncResult | null;
  load: () => Promise<void>;
  upsert: (prices: ModelPrice[]) => Promise<void>;
  delete: (models: string[]) => Promise<void>;
  sync: (targets?: string[]) => Promise<ModelPriceSyncResult>;
  applyCandidate: (candidate: ModelPriceSyncCandidate) => Promise<void>;
  applyCandidates: (candidates: ModelPriceSyncCandidate[]) => Promise<void>;
  discover: () => Promise<string[]>;
  pushBackendCache: () => Promise<void>;
  clearCandidates: () => void;
}

const MODEL_PRICE_COLUMNS = [
  "model",
  "input_per_1m",
  "output_per_1m",
  "cache_read_per_1m",
  "cache_creation_per_1m",
  "source",
  "source_model_id",
  "raw_json",
  "updated_at_ms",
  "synced_at_ms",
] as const;

let loadPromise: Promise<void> | null = null;

const PRICE_UNIT_SCALE = 1_000_000;
const OPENROUTER_CACHE_READ_KEYS = ["input_cache_read", "cache_read", "cache"] as const;
const OPENROUTER_CACHE_CREATION_KEYS = ["input_cache_write", "cache_creation", "cache_write"] as const;
const LITELLM_CACHE_READ_KEYS = ["cache_read_input_token_cost", "input_cost_per_token_cache_read"] as const;
const LITELLM_CACHE_CREATION_KEYS = ["cache_creation_input_token_cost", "input_cost_per_token_cache_creation"] as const;

function normalizePrice(price: ModelPrice): ModelPrice {
  const now = Date.now();
  return {
    ...price,
    model: price.model.trim(),
    inputPer1m: sanitizePrice(price.inputPer1m),
    outputPer1m: sanitizePrice(price.outputPer1m),
    cacheReadPer1m: sanitizePrice(price.cacheReadPer1m),
    cacheCreationPer1m: sanitizePrice(price.cacheCreationPer1m),
    contextWindow: resolvePriceContextWindow(price.source, price.rawJson, price.contextWindow),
    source: price.source || "manual",
    sourceModelId: price.sourceModelId ?? null,
    rawJson: price.rawJson ?? null,
    updatedAtMs: price.updatedAtMs > 0 ? price.updatedAtMs : now,
    syncedAtMs: price.syncedAtMs ?? null,
  };
}

function sanitizePrice(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseRawPricePer1m(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value * PRICE_UNIT_SCALE : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed * PRICE_UNIT_SCALE : null;
  }
  return null;
}

function rawPricingRecord(source: string | null | undefined, rawJson: string | null): Record<string, unknown> | null {
  if (!rawJson) return null;
  try {
    const parsed = asRecord(JSON.parse(rawJson) as unknown);
    if (!parsed) return null;
    if (source === "openrouter") {
      return asRecord(parsed.pricing);
    }
    return parsed;
  } catch {
    return null;
  }
}

function cachePriceKeys(source: string | null | undefined, kind: "read" | "creation"): readonly string[] {
  if (source === "openrouter") {
    return kind === "read" ? OPENROUTER_CACHE_READ_KEYS : OPENROUTER_CACHE_CREATION_KEYS;
  }
  if (source === "litellm") {
    return kind === "read" ? LITELLM_CACHE_READ_KEYS : LITELLM_CACHE_CREATION_KEYS;
  }
  return [];
}

function readRawCachePrice(
  source: string | null | undefined,
  rawJson: string | null,
  kind: "read" | "creation"
): { present: boolean; value: number | null } {
  const pricing = rawPricingRecord(source, rawJson);
  if (!pricing) return { present: false, value: null };
  for (const key of cachePriceKeys(source, kind)) {
    if (!Object.prototype.hasOwnProperty.call(pricing, key)) continue;
    return { present: true, value: parseRawPricePer1m(pricing[key]) };
  }
  return { present: false, value: null };
}

function hydrateStoredCachePrice(
  source: string | null | undefined,
  rawJson: string | null,
  storedValue: number,
  kind: "read" | "creation"
): number {
  const raw = readRawCachePrice(source, rawJson, kind);
  if (raw.present) return sanitizePrice(raw.value ?? 0);
  return sanitizePrice(storedValue);
}

function mergeRemoteCachePrice(
  source: string | null | undefined,
  rawJson: string | null,
  remoteValue: number,
  existingValue: number | undefined,
  kind: "read" | "creation"
): number {
  const raw = readRawCachePrice(source, rawJson, kind);
  if (raw.present) return sanitizePrice(raw.value ?? 0);
  const next = sanitizePrice(remoteValue);
  if (next > 0) return next;
  return sanitizePrice(existingValue ?? next);
}

function resolvePriceContextWindow(source: string | null | undefined, rawJson: string | null, exact?: unknown): number | null {
  return normalizeContextLimit(exact) ?? extractModelContextWindow(rawJson, source ?? undefined);
}

function rowToPrice(row: ModelPriceRow): ModelPrice {
  return {
    model: row.model,
    inputPer1m: row.input_per_1m,
    outputPer1m: row.output_per_1m,
    cacheReadPer1m: hydrateStoredCachePrice(row.source, row.raw_json, row.cache_read_per_1m, "read"),
    cacheCreationPer1m: hydrateStoredCachePrice(row.source, row.raw_json, row.cache_creation_per_1m, "creation"),
    contextWindow: resolvePriceContextWindow(row.source, row.raw_json),
    source: row.source,
    sourceModelId: row.source_model_id,
    rawJson: row.raw_json,
    updatedAtMs: row.updated_at_ms,
    syncedAtMs: row.synced_at_ms,
  };
}

function priceToDbValues(price: ModelPrice): unknown[] {
  return [
    price.model,
    price.inputPer1m,
    price.outputPer1m,
    price.cacheReadPer1m,
    price.cacheCreationPer1m,
    price.source,
    price.sourceModelId,
    price.rawJson,
    price.updatedAtMs,
    price.syncedAtMs,
  ];
}

function toBackendEntry(price: ModelPrice): BackendModelPriceEntry {
  return {
    model: price.model,
    inputPer1m: price.inputPer1m,
    outputPer1m: price.outputPer1m,
    cacheReadPer1m: price.cacheReadPer1m,
    cacheCreationPer1m: price.cacheCreationPer1m,
    source: price.source,
    sourceModelId: price.sourceModelId,
    rawJson: price.rawJson,
    updatedAtMs: price.updatedAtMs,
    syncedAtMs: price.syncedAtMs,
  };
}

async function pushPricesToBackendCache(prices: ModelPrice[]): Promise<void> {
  await invoke("model_prices_set_cache", { prices: prices.map(toBackendEntry) });
}

async function tryPushPricesToBackendCache(prices: ModelPrice[]): Promise<void> {
  try {
    await pushPricesToBackendCache(prices);
  } catch (err) {
    logWarn("Failed to push model pricing cache to backend", err);
  }
}

function remoteToPrice(targetModel: string, remote: RemoteModelPrice, existing?: ModelPrice): ModelPrice {
  const now = Date.now();
  return {
    model: targetModel.trim(),
    inputPer1m: sanitizePrice(remote.inputPer1m),
    outputPer1m: sanitizePrice(remote.outputPer1m),
    cacheReadPer1m: mergeRemoteCachePrice(remote.source, remote.rawJson, remote.cacheReadPer1m, existing?.cacheReadPer1m, "read"),
    cacheCreationPer1m: mergeRemoteCachePrice(remote.source, remote.rawJson, remote.cacheCreationPer1m, existing?.cacheCreationPer1m, "creation"),
    contextWindow: resolvePriceContextWindow(remote.source, remote.rawJson, remote.contextWindow),
    source: remote.source,
    sourceModelId: remote.sourceModelId || remote.model,
    rawJson: remote.rawJson,
    updatedAtMs: now,
    syncedAtMs: now,
  };
}

function makePriceMap(prices: ModelPrice[]): Record<string, ModelPrice> {
  const map: Record<string, ModelPrice> = {};
  for (const price of prices) {
    if (!price.model.trim()) continue;
    map[price.model] = normalizePrice(price);
  }
  return map;
}

async function ensureModelPricesTable(): Promise<void> {
  const db = await getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS model_prices (
      model TEXT PRIMARY KEY,
      input_per_1m REAL NOT NULL DEFAULT 0,
      output_per_1m REAL NOT NULL DEFAULT 0,
      cache_read_per_1m REAL NOT NULL DEFAULT 0,
      cache_creation_per_1m REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      source_model_id TEXT,
      raw_json TEXT,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      synced_at_ms INTEGER
    )
  `);
}

async function readAllPrices(): Promise<ModelPrice[]> {
  await ensureModelPricesTable();
  const db = await getDb();
  const rows = await db.select<ModelPriceRow[]>(
    `SELECT ${MODEL_PRICE_COLUMNS.join(", ")} FROM model_prices ORDER BY model COLLATE NOCASE`
  );
  return rows.map(rowToPrice);
}

async function writePrices(prices: ModelPrice[]): Promise<ModelPrice[]> {
  if (prices.length === 0) return [];
  await ensureModelPricesTable();
  const db = await getDb();
  const normalized = prices.map(normalizePrice);
  for (const price of normalized) {
    await db.execute(
      `INSERT INTO model_prices (${MODEL_PRICE_COLUMNS.join(", ")})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT(model) DO UPDATE SET
         input_per_1m = excluded.input_per_1m,
         output_per_1m = excluded.output_per_1m,
         cache_read_per_1m = excluded.cache_read_per_1m,
         cache_creation_per_1m = excluded.cache_creation_per_1m,
         source = excluded.source,
         source_model_id = excluded.source_model_id,
         raw_json = excluded.raw_json,
         updated_at_ms = excluded.updated_at_ms,
         synced_at_ms = excluded.synced_at_ms`,
      priceToDbValues(price)
    );
  }
  return normalized;
}

export const useModelPricingStore = create<ModelPricingStore>((set, get) => ({
  modelPrices: {},
  discoveredModels: [],
  candidates: [],
  unmatchedModels: [],
  loaded: false,
  priceTableReady: false,
  loading: false,
  syncing: false,
  discovering: false,
  error: null,
  lastSyncResult: null,

  load: async () => {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      set({ loading: true, error: null });
      try {
        let prices = await readAllPrices();
        if (prices.length === 0) {
          prices = await writePrices(DEFAULT_MODEL_PRICES);
        }
        set({ modelPrices: makePriceMap(prices), loaded: true, priceTableReady: true, loading: false });
        await tryPushPricesToBackendCache(Object.values(get().modelPrices));
      } catch (err) {
        const message = String(err);
        set({ error: message, loaded: true, priceTableReady: false, loading: false });
        await tryPushPricesToBackendCache(Object.values(get().modelPrices));
      } finally {
        loadPromise = null;
      }
    })();
    return loadPromise;
  },

  upsert: async (prices) => {
    const saved = await writePrices(prices);
    set((state) => ({ modelPrices: { ...state.modelPrices, ...makePriceMap(saved) }, priceTableReady: true, error: null }));
    await get().pushBackendCache();
  },

  delete: async (models) => {
    if (models.length === 0) return;
    await ensureModelPricesTable();
    const db = await getDb();
    for (const model of models) {
      await db.execute("DELETE FROM model_prices WHERE model = $1", [model]);
    }
    set((state) => {
      const next = { ...state.modelPrices };
      for (const model of models) delete next[model];
      return { modelPrices: next, priceTableReady: true, error: null };
    });
    await get().pushBackendCache();
  },

  sync: async (targets) => {
    await get().load();
    const effectiveTargets = targets && targets.length > 0
      ? targets
      : Array.from(new Set([...Object.keys(get().modelPrices), ...get().discoveredModels]));
    set({ syncing: true, error: null });
    try {
      const result = await invoke<ModelPriceSyncResult>("model_prices_sync", { targets: effectiveTargets });
      const currentPrices = get().modelPrices;
      const matchedPrices = result.matched.map((match) =>
        remoteToPrice(match.targetModel, match.remote, currentPrices[match.targetModel])
      );
      if (matchedPrices.length > 0) {
        await get().upsert(matchedPrices);
      }
      set({
        candidates: result.candidates,
        unmatchedModels: result.unmatched,
        lastSyncResult: result,
        syncing: false,
      });
      return result;
    } catch (err) {
      const message = String(err);
      set({ error: message, syncing: false });
      throw err;
    }
  },

  applyCandidate: async (candidate) => {
    await get().upsert([
      remoteToPrice(candidate.targetModel, candidate.remote, get().modelPrices[candidate.targetModel]),
    ]);
    set((state) => ({
      candidates: state.candidates.filter((item) => item.targetModel !== candidate.targetModel),
      unmatchedModels: state.unmatchedModels.filter((model) => model !== candidate.targetModel),
    }));
  },

  applyCandidates: async (selected) => {
    if (selected.length === 0) return;
    // 每个目标模型只取第一条候选（调用方负责按目标去重并传入期望的那一条）。
    const seenTargets = new Set<string>();
    const prices: ModelPrice[] = [];
    for (const candidate of selected) {
      if (seenTargets.has(candidate.targetModel)) continue;
      seenTargets.add(candidate.targetModel);
      prices.push(
        remoteToPrice(candidate.targetModel, candidate.remote, get().modelPrices[candidate.targetModel])
      );
    }
    if (prices.length === 0) return;
    await get().upsert(prices);
    set((state) => ({
      candidates: state.candidates.filter((item) => !seenTargets.has(item.targetModel)),
      unmatchedModels: state.unmatchedModels.filter((model) => !seenTargets.has(model)),
    }));
  },

  discover: async () => {
    set({ discovering: true, error: null });
    try {
      const rawModels = await fetchDiscoveredModels();
      const models = Array.from(
        new Set(
          rawModels.filter((model) => model.length > 0 && normalizeModelId(model) !== null)
        )
      ).sort((a, b) => a.localeCompare(b));
      set({ discoveredModels: models, discovering: false });
      return models;
    } catch (err) {
      const message = String(err);
      set({ error: message, discovering: false });
      return [];
    }
  },

  pushBackendCache: async () => {
    await pushPricesToBackendCache(Object.values(get().modelPrices));
  },

  clearCandidates: () => set({ candidates: [], unmatchedModels: [], lastSyncResult: null }),
}));

registerModelPriceProvider(() => {
  const state = useModelPricingStore.getState();
  return { prices: state.modelPrices, authoritative: state.priceTableReady };
});
