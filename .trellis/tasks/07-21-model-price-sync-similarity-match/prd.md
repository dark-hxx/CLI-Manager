# Model Price Sync Similarity Match

## Goal

优化「设置 → 模型价格 → 同步缺失价格」的远程模型匹配，使带后缀的本地模型名（如 `grok-4.5-build-free`）在远端存在基座价（如 `grok-4.5`）时进入候选列表，而不是 unmatched。

## Changelog Target

`[TEMP]`

## What I Already Know

- 同步入口：`model_prices_sync`（`src-tauri/src/commands/model_pricing.rs`）
- 匹配在 `rank_candidates`：Exact / CaseInsensitive / Normalized / ReasoningVariant / Tail / Alnum / Fuzzy
- 自动应用仅 Exact / CaseInsensitive / Normalized（`is_auto_match_kind`）
- Fuzzy 用字符 Jaccard + Levenshtein，门槛 `MIN_CANDIDATE_SCORE = 0.70`
- `grok-4.5-build-free` vs `grok-4.5` 综合分约 0.43，被丢弃
- 前端 store/UI 只消费 matched/candidates/unmatched，不改匹配算法
- GitNexus impact：`rank_candidates` risk LOW，仅 `model_prices_sync` 与单测上游

## Requirements

- 增加 token 前缀基座匹配：远端较短 token 序列是本地较长序列的连续前缀时，作为 candidate（不 auto-apply）
- 改进 Fuzzy：混入 token containment，避免纯字符级被后缀拉垮
- 现有 auto-apply 规则不变
- 单测覆盖 `grok-4.5-build-free` → `grok-4.5` 候选场景
- 同步契约文档中写明 BasePrefix / 改进 Fuzzy
- CHANGELOG 记到 `[TEMP]`

## Acceptance Criteria

- [x] `rank_candidates("grok-4.5-build-free", [grok-4.5])` 返回 candidate，score ≥ 0.70
- [x] 该匹配 kind 不进 `is_auto_match_kind`
- [x] 无关模型仍 unmatched
- [x] 现有 Exact / Normalized / ReasoningVariant / Alnum 行为不被破坏
- [x] `cargo test model_pricing` 通过
- [x] CHANGELOG `[TEMP]` 有条目

## Definition of Done

- 最小改动：仅后端匹配 + 契约 + CHANGELOG
- 不改 schema / 前端 store / 自动应用策略
- 单测覆盖关键 case

## Out of Scope

- 新远程价格源
- 前端候选 UI 改版
- 自动应用基座匹配

## Technical Notes

- 主要文件：`src-tauri/src/commands/model_pricing.rs`
- 契约：`.trellis/spec/backend/model-pricing-contracts.md`
