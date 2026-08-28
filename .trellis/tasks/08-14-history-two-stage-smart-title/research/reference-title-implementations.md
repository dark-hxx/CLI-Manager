# Reference title implementations

## Scope

Research supporting Issue #184 phase B. Evidence distinguishes public local behavior from closed-source assumptions.

## DeepSeek Harness

Repository inspected read-only at `F:\github\deepseek-harness`, HEAD `47f943859b`.

- `@deepseek-ai/dsh-session-title` stores append-only `session/title` revisions with `fallback | provider | user` provenance and latest-wins projection.
- The first eligible real human text immediately produces a deterministic fallback. Default bundle limits: 5 words, 40 UTF-8 bytes; accepted titles max 80 bytes.
- Default `first-prompt` provider sends only the first eligible human message. An optional `all-prompts` provider regenerates from all human prompts.
- The LLM helper can inherit the exact logged main request route or use an explicit provider/model pair. It frames messages as JSON, disables tools by contract, caps input/output, applies timeout, records the exact auxiliary request, and accepts text-only normal-stop output.
- Automatic failure preserves fallback. Per-session revision plus cancellation prevents stale responses from overwriting newer automatic or user titles.
- User rename pins the title; later prompts do not schedule automatic generation until an explicit refresh.
- Forks inherit title events; the first-prompt provider does not automatically rename a fork.
- Normalization strips terminal/control/bidi/invisible sequences, collapses whitespace, and truncates by UTF-8 bytes without splitting code points.

Primary evidence:

- `F:\github\deepseek-harness\docs\subsystems\session-title.zh.md`
- `F:\github\deepseek-harness\packages\session\session-title\src\index.ts`
- `F:\github\deepseek-harness\packages\session\session-title\src\normalize.ts`
- `F:\github\deepseek-harness\packages\session\session-title-llm\src\index.ts`
- `F:\github\deepseek-harness\packages\session\session-title-first-prompt-llm\src\index.ts`
- `F:\github\deepseek-harness\packages\session\session-title-all-prompts-llm\src\index.ts`
- `F:\github\deepseek-harness\packages\bundle\base\cordis.patch.yml`

## Cherry Studio

Official repository `CherryHQ/cherry-studio`, inspected around main commit `d5c511017b85763884ce872da66380b71d8b61ef`.

- `TopicNamingService` first derives a temporary title locally from the first user text, with normalized whitespace and a 50-code-unit limit guarded against splitting an emoji surrogate pair.
- After the first conversation is persisted, it may generate one semantic title from structured user and assistant main text. Tools and reasoning are not sent; user file names may be included.
- Default prompt asks for a title in the configured language within 10 words, without punctuation/symbols, and output-only title text. Users can enable/disable naming and customize the prompt.
- Model resolution reuses the quick-assistant model, then chat default model, then a managed CherryAI default. External-CLI providers without app-side credentials are rejected.
- The title request omits the source assistant identity, therefore does not inherit MCP/web/knowledge tools, and explicitly sets reasoning effort to none.
- Before writeback it rereads the latest topic/session. `isNameManuallyEdited` and temporary-title comparison prevent a late result from overwriting a manual or already-generated title.
- Failure preserves the temporary title and surfaces a notification; it does not loop automatically.

Primary evidence:

- https://github.com/CherryHQ/cherry-studio/blob/d5c511017b85763884ce872da66380b71d8b61ef/src/main/services/TopicNamingService.ts
- https://github.com/CherryHQ/cherry-studio/blob/d5c511017b85763884ce872da66380b71d8b61ef/src/renderer/pages/settings/ModelSettings/TopicNamingSettings.tsx
- https://github.com/CherryHQ/cherry-studio/blob/d5c511017b85763884ce872da66380b71d8b61ef/src/shared/utils/conversationTitle.ts
- https://github.com/CherryHQ/cherry-studio/blob/d5c511017b85763884ce872da66380b71d8b61ef/src/main/data/db/schemas/topic.ts

## OpenAI Codex

Official `openai/codex` public repository inspected at `9d012ca4f54c5adc86e605a7bedbdd03ef63f516`.

- The public local CLI/app-server path deterministically derives an unnamed thread title and preview from the first effective `UserMessage`, after stripping internal prefixes. It does not make an auxiliary title-model request.
- Explicit thread names come from user strings through `/rename`, `/new NAME`, `/clear NAME`, or app-server `thread/name/set`; input is trimmed and empty names are rejected.
- Names are stored in state SQLite (`title` for legacy history and `name` for paginated history) and compatibility `session_index.jsonl` entries are append-only/latest-wins.
- Public cloud backend DTOs contain `title` and `has_generated_title`, but the generation service, trigger, input, prompt, model, billing, retry, and persistence implementation are not public. The DTO does not prove LLM generation and must not be extrapolated to Desktop local thread names.

Primary evidence:

- https://github.com/openai/codex/blob/9d012ca4f54c5adc86e605a7bedbdd03ef63f516/codex-rs/state/src/extract.rs#L138-L150
- https://github.com/openai/codex/blob/9d012ca4f54c5adc86e605a7bedbdd03ef63f516/codex-rs/app-server/src/request_processors/thread_processor.rs#L1669-L1700
- https://github.com/openai/codex/blob/9d012ca4f54c5adc86e605a7bedbdd03ef63f516/codex-rs/rollout/src/session_index.rs#L21-L70
- https://github.com/openai/codex/blob/9d012ca4f54c5adc86e605a7bedbdd03ef63f516/codex-rs/codex-backend-openapi-models/src/models/task_response.rs#L15-L40

## Adopted direction for CLI-Manager

Combine the strongest public patterns:

1. Codex: the first real user prompt remains a deterministic, zero-cost source title.
2. Cherry Studio: optionally replace the temporary/source title once with an asynchronous semantic title, without inheriting tools/reasoning.
3. DeepSeek Harness: explicit provenance, revision/CAS protection, user pin semantics, bounded input/output, text-only validation, safe normalization, and lossless failure fallback.

Do not claim that Codex Desktop publicly documents or implements a reproducible LLM title algorithm.