# Codex SubagentStart Hook Support

## Goal

Enable Codex sub-agent sessions started by `spawn_agent` to appear in the existing sub-agent split-pane/transcript flow by wiring Codex `SubagentStart` hook events into the current hook pipeline.

## Requirements

* Register Codex `SubagentStart` hooks during install, uninstall, and status checks.
* Allow Codex `SubagentStart` in the Rust hook bridge event whitelist.
* Preserve and forward `transcript_path` from Codex hook payloads.
* Let the frontend use `agentTranscriptPath` first, then fall back to `transcriptPath`.
* Extend the sub-agent transcript renderer to support Codex `response_item` records with `payload.message`, `output_text`, and `function_call` content.
* Render sub-agent transcript text as Markdown with the existing application Markdown renderer.
* Register and handle `SubagentStop` so finished sub-agent panes close automatically after a short grace delay.
* Keep existing Claude sub-agent behavior unchanged.

## Acceptance Criteria

* [ ] Codex hook install writes a `SubagentStart` entry.
* [ ] Codex `SubagentStart` events are accepted by the bridge.
* [ ] Frontend sub-agent session creation can use Codex-provided `transcript_path`.
* [ ] `SubagentTranscriptView` renders both Claude transcript entries and Codex `response_item` transcript entries.
* [ ] Sub-agent transcript content renders Markdown instead of plain preformatted text.
* [ ] `SubagentStop` marks the matching pane finished and closes it automatically.
* [ ] TypeScript type-check passes.
* [ ] Rust compile check passes for touched backend code.

## Definition of Done

* Minimal additive code changes only.
* No dependency changes.
* No unrelated refactor.
* Verify with static checks and direct inspection where runtime hook execution cannot be exercised.

## Technical Approach

Reuse the existing pseudo-session/split-pane/tail channel. Add the missing Codex event registration and whitelist entry, pass through the explicit transcript path, and make the transcript parser format-compatible with Codex while keeping the Claude parser path intact.

## Out of Scope

* Changing Claude hook behavior.
* Adding new UI surfaces beyond parsing/rendering Codex transcript entries in the existing view.
* Supporting Codex versions that do not emit `SubagentStart`; they should simply continue not triggering the flow.

## Technical Notes

* User-provided diagnosis identifies impacted files:
  * `src-tauri/src/commands/hook_settings.rs`
  * `src-tauri/src/claude_hook.rs`
  * `src-tauri/src/hook_client.rs`
  * `src/stores/terminalStore.ts`
  * `src/components/SubagentTranscriptView.tsx`
