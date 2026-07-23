# Research: Terminal stats + Grok signals

## TerminalStatsPanel (Claude path)

- Binds only when `terminalSession.cliSessionId` matches loaded session `session_id`.
- Lookup: `fetchLatestProjectSessionDetail(projectPath, prev, sourceFilter, cliSessionId, { forceCatalogRefresh })`.
- `sourceFilter` from `inferHistorySource(startupCmd|title|cli_tool)` — **no grok today**.
- Cards use `usage.input_tokens/output_tokens/cache_*/context_window/current_model` + tool stats.

## Grok on-disk

```
~/.grok/sessions/<encoded-cwd>/<session-id>/
  summary.json    # info.id, current_model_id, titles, cwd
  updates.jsonl   # conversation + tool_call stream (parser already)
  signals.json    # turn/tool/token-ish aggregates
```

Sample `signals.json` fields (observed):

- `contextTokensUsed`, `contextWindowTokens`
- `primaryModelId`, `modelsUsed`
- `toolCallCount`, `toolsUsed`
- No separate input/output billing split in sample

## Parser gap

`scan_grok_jsonl_session` sets model + tool_call_count; does not load signals → TerminalStats token cards stay empty even when bound.

## S3 recommendation

1. Hook bind session id (S1).
2. infer source grok.
3. Merge signals into SessionStatsScan for context + best-effort tokens.
4. Do not use ccusage.
