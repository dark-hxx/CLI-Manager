# Model Pricing Contracts

> Executable contracts for user-configurable model prices, remote price sync, and cross-layer cost calculation.

---

## Scenario: Model pricing table + backend cache bridge

### 1. Scope / Trigger

- Trigger: changes touching `model_prices` SQLite schema, `model_prices_set_cache`, `model_prices_sync`, `src/lib/modelPricing.ts`, `src/stores/modelPricingStore.ts`, or history cost calculation in `src-tauri/src/commands/history.rs`.
- This is a cross-layer contract because the WebView owns the app SQLite connection through `tauri-plugin-sql`, Rust owns history JSONL scanning and cost aggregation, and both layers must use the same user-configured prices.
- The authoritative persisted source is the frontend-managed SQLite table. Rust history code must never silently maintain a separate persisted model-price store.

### 2. Signatures

SQLite migration:

```sql
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
);
```

Rust commands:

```rust
#[tauri::command]
pub fn model_prices_set_cache(prices: Vec<ModelPriceEntry>) -> Result<(), String>

#[tauri::command]
pub async fn model_prices_sync(targets: Vec<String>) -> Result<ModelPriceSyncResult, String>
```

Frontend store surface:

```ts
interface ModelPricingStore {
  modelPrices: Record<string, ModelPrice>;
  discoveredModels: string[];
  syncResult: ModelPriceSyncResult | null;
  loaded: boolean;
  priceTableReady: boolean;
  load(): Promise<void>;
  upsert(model: string, price: ModelPrice): Promise<void>;
  remove(model: string): Promise<void>;
  discoverModels(): Promise<string[]>;
  syncPrices(targets?: string[]): Promise<ModelPriceSyncResult>;
  applyCandidate(target: string, candidate: ModelPriceSyncCandidate): Promise<void>;
  pushBackendCache(): Promise<void>;
}
```

Cost calculation surfaces:

```ts
calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  model: string | null,
): number
```

```rust
fn calculate_usage_cost(model: Option<&str>, usage: UsageTokenScan) -> UsageStatsScan
```

### 3. Contracts

- Price units are **USD per 1M tokens** at every boundary. Remote provider values that are per-token must be multiplied by `1_000_000` before storing or returning to the frontend.
- Valid price fields are non-negative finite numbers. Invalid, NaN, infinite, or negative values must be rejected or ignored before they reach cost calculation.
- Normal `model_prices` CRUD is persisted by the WebView using `getDb()` / `tauri-plugin-sql`. Rust receives a runtime cache through `model_prices_set_cache`; this avoids coupling pricing commands to plugin-sql's internal database path.
- Versioned backup restore is the narrow exception: its Rust restore command resolves the canonical database through `app_paths::db_path()`, refuses to create a missing database, and replaces selected database domains on one connection so transaction control cannot drift across the plugin SQL pool.
- Frontend startup must load/seed `model_prices` and then best-effort push the full table to `model_prices_set_cache` before history stats are likely opened. Failure to push the cache must not crash the app; history calculation reports unpriced tokens until the cache is available.
- Once the DB-backed table is loaded and pushed, the model-price cache is authoritative. If a model is missing from the loaded table, cost calculation must return unpriced tokens, not fall back to stale hardcoded defaults for that model.
- Hardcoded prices are seed data only: when `model_prices` is empty, insert default rows with `source='builtin'`. Runtime cost calculation must not maintain a second hardcoded pricing table.
- Remote sync is advisory. `model_prices_sync` fetches LiteLLM and OpenRouter, parses remote rows, matches targets, and returns matched/candidate/unmatched results. The command does **not** write SQLite; the frontend writes accepted prices and then pushes the cache.
- Auto-apply sync matches only when confidence is deterministic (exact, case-insensitive, or full normalized identity). Tail, alnum, base-prefix, and fuzzy similarity matches must be presented as candidates for user confirmation.
- Base-prefix matching: after dash-token split of normalized tails, if the shorter token sequence has ≥2 tokens and is a continuous prefix of the longer one (e.g. local `grok-4.5-build-free` vs remote `grok-4.5` / `xai/grok-4.5`), surface it as a candidate with score `0.90 + 0.05 * (short/long)`. Never auto-apply base-prefix hits.
- Fuzzy scoring mixes token containment (shared tokens / shorter side), character Levenshtein similarity, and character Jaccard, with threshold `MIN_CANDIDATE_SCORE = 0.70`. Pure character-only scoring must not discard clear base-model candidates that only differ by marketing/build suffixes.
- Model context limits for UI display use a shared frontend resolver: exact log value first, then model metadata cached in `model_prices.raw_json`, then local model-name rules, then unknown. Do not add a database migration only for context-window metadata unless a future feature needs querying/sorting by that field.
- Context metadata parsing is field-whitelisted. LiteLLM rows may use `max_input_tokens`, `context_window`, or `max_tokens`; OpenRouter rows may use `context_length`. If a LiteLLM row has tiered pricing keys like `input_cost_per_token_above_272k_tokens`, use that lowest `above_<N>k_tokens` cutoff as the standard context display limit before `max_input_tokens`. Unknown/missing fields are ignored instead of guessed.
- `ccusage` reports keep using the external ccusage tool's own cost fields. Do not override ccusage costs with the local `model_prices` table unless a future task explicitly changes that contract.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| `model_prices` table is empty | Insert default seed rows, set `priceTableReady=true`, push backend cache. |
| Startup cache push fails | Log/handle as best effort; app remains usable; backend reports usage as unpriced until cache is set. |
| User deletes a model price after table load | Remove row, push cache; that model becomes unpriced in frontend and backend calculations. |
| Remote source fails but another source succeeds | Return partial success with source status/error; do not fail the entire sync if at least one source yielded data. |
| All remote sources fail | Return a clear error from `model_prices_sync`; frontend keeps existing prices unchanged. |
| Remote row lacks input/output/cache price fields | Skip that row or mark source skipped; never store a row with accidental zero prices unless zero was explicitly present. |
| Remote row lacks context-window metadata | Keep the model price usable; context limit falls through to local rules or unknown. |
| Remote row exposes a supported positive context-window field | Cache it in memory from `raw_json` and let `resolveContextLimit` use it before local rules. |
| LiteLLM row exposes both `max_input_tokens` and tier cutoff fields such as `*_above_272k_tokens` | Display the tier cutoff as the standard context limit; do not show the larger theoretical maximum for normal context cards. |
| Too many sync targets | Deduplicate and cap targets before remote matching to avoid UI-triggered expensive matching work. |
| Candidate accepted | Upsert accepted price, clear stale candidates for that target, push backend cache. |
| Explicit cost exists in history JSONL | Do not use it as billing authority; calculate from local model prices when possible, otherwise mark tokens unpriced. |
| Model is unknown with loaded cache | Add usage tokens to `unpriced_tokens`; do not estimate cost. |

### 5. Good/Base/Bad Cases

- Good: first launch after migration creates `model_prices`, seeds builtin rows, pushes backend cache, and both terminal realtime stats and history stats use the same edited price.
- Good: `anthropic/claude-sonnet-4-5` from LiteLLM is suggested as a candidate for local `claude-sonnet-4-5`; the user confirms it before DB write.
- Good: a synced LiteLLM row with `max_input_tokens` or an OpenRouter row with `context_length` lets context UI show the model limit even when history logs omit `context_window`.
- Good: a synced LiteLLM `gpt-5.5` row with `max_input_tokens: 1050000` and `*_above_272k_tokens` tier keys displays `272K`, not `1.1M`, in normal context cards.
- Base: network is offline; the settings page can still show existing/manual prices and users can edit them.
- Base: a model appears in history `model_distribution` but has no row in `model_prices`; UI lists it as missing and history stats count its tokens as unpriced.
- Base: a model has prices but no context metadata; cost calculation still works and context UI falls through to local rules/unknown.
- Bad: deleting `claude-sonnet-4-5` causes cost calculation to use the hardcoded seed row anyway. Once the table is loaded, missing means unpriced.
- Bad: UI components duplicate provider-specific context-window parsing instead of calling `resolveContextLimit(model, exactLimit)`.
- Bad: Rust guesses a `cli-manager.db` filesystem path instead of resolving the canonical app data path, creating a second persistence location that can drift from `tauri-plugin-sql`.

### 6. Tests Required

- Frontend type/build checks:
  - `npx tsc --noEmit` must pass after changing pricing types/store/UI.
  - Verify `calculateCost` uses loaded store prices and falls back only before `priceTableReady`.
  - Verify `resolveContextLimit(model, exactLimit)` prefers exact values, then cached metadata from `raw_json`, then local model-name rules, then `null`.
- Rust checks:
  - `cd src-tauri && cargo check` must pass after changing command signatures or history pricing.
  - Unit tests (when added) should assert exact/case-insensitive matches auto-apply while tail/alnum/base-prefix/fuzzy matches remain candidates.
  - Unit tests should assert missing/unavailable model pricing returns `unpriced_tokens` instead of fallback cost.
  - Unit tests should assert `grok-4.5-build-free` ranks remote `grok-4.5` as a base-prefix candidate (score ≥ 0.70, not auto-apply).
- Manual UI checks:
  - Open Settings → 模型价格, identify local models, sync prices, edit/delete a row, and confirm a candidate.
  - Open history stats after an edit and confirm cost changes consistently with terminal realtime estimate.

### 7. Wrong vs Correct

#### Wrong

```rust
let pricing = find_hardcoded_price(model).or_else(|| find_cached_price(model));
```

This lets stale built-in defaults override a user's delete/edit decision.

#### Correct

```rust
match find_cached_model_pricing(model) {
    CacheLookup::Hit(price) => Some(price),
    CacheLookup::MissLoaded => None,
    CacheLookup::Unavailable => None,
}
```

Only calculate cost from the DB-backed cache. Built-in prices seed the table on first launch; they are not a second runtime pricing source.

#### Wrong

```rust
let db_path = app.path().app_local_data_dir()?.join("cli-manager.db");
// Rust writes the same table directly.
```

This couples backend code to plugin-sql storage details and creates two owners for the same data.

#### Correct

```ts
await modelPricingStore.load();          // WebView owns getDb()/SQLite writes
await modelPricingStore.pushBackendCache(); // Rust receives runtime cache
```

Keep persistence in the same layer as existing app tables and bridge only the read-only runtime data Rust needs for history cost calculation.
