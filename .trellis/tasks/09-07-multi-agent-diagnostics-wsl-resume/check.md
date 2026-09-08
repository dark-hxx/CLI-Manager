# Verification report

## Result
Implementation complete in `fix/multi-agent-diagnostics-wsl-resume`, based on current committed `refactor/ai-architecture` HEAD `563abf756e608cbd952dc33a709e43584f77a509`. No upstream configured; no pull, merge, rebase, commit or push. Original worktree and native transcripts were not edited. Code remains available for review.

## Root causes and discovery list
1. Native tool schemas differed, and stats adapters independently counted MCP as builtin; the catalog writer stored `mcp:<server>` while its reader only recognized `mcp`. Fix at adapter normalization and catalog boundaries, with derived parser-version invalidation.
2. Codex orchestration logs exposed outer `exec` requests and custom results, while the old reader ignored custom results and nested call sites. Static nested calls are now separate inferred observations with deterministic parent/position provenance; they are not proof of execution. Comments, strings, dynamic access and ambiguous regex/division syntax are omitted. Scripts are never evaluated.
3. Health consumers accepted unfinished events as success, and a probe lacking health replaced real runtime evidence with unknown. Shared evidence rules now require exact session/Agent binding and explicit terminal results; unknown probes preserve known evidence. WSL terminal metadata now routes diagnostics through WSL.
4. History's Linux cwd crossed unchanged into Windows CreateProcessW. Resume now preserves explicit distro and config-home identity; the PTY layer passes guest cwd via WSL arguments and uses a host-valid cwd. Project/worktree matching rejects distro conflicts. Unsupported resume sources cannot enter the launch path.

## Coverage
- Existing history sources: Claude, Codex, Gemini, Copilot, Antigravity, Grok, Kimi, Pi, OpenCode, Kiro, Cursor and Cline; no new collector or dependency.
- Shared native-format regressions: Anthropic blocks, OpenAI tool arrays, Gemini toolCalls, Bedrock toolUse/toolResult, Copilot execution events; actual Pi/Grok/Kimi files and OpenCode SQLite data.
- Catalog regression: real shadow materialization/readback verifies MCP server aggregation, message linkage and inferred provenance exclusion.
- All five diagnostic Agents: unknown/unsupported probes preserve success and failure evidence. Frontend excludes started, pending, cancelled, denied and inferred observations.
- All six supported resume Agents: WSL distro, spaces, UNC aliases, Windows mount translation, conflicting/missing identity; Windows host cwd is unset. Existing native/SSH builders and exact IDs retain their tests.

## Automated validation
- 54 Node tests passed across agent capabilities, resume/environment, history conversation, terminal stats, CLI session and Pi compatibility suites.
- 211 Rust history tests passed, including 8 added observation/catalog/native-file regressions.
- 11 shared Agent capability tests passed, including all five Agent kinds.
- 1 WSL launch boundary test passed.
- `npx tsc --noEmit`, `npm run build`, `cargo check` passed.
- `npm run check:architecture` and strict architecture check passed: 956 handwritten source files, zero over 2000 lines and zero violations.
- `git diff --check` passed. GitNexus detect_changes reports shared history/PTY/UI flows with critical aggregate risk; reviewed against the planned three cross-layer fixes. Its index describes the baseline, so new modules were also reviewed directly.

## Manual acceptance still needed
No desktop application was launched. Actual WSL CLI resume, MCP server connectivity and Settings language-switch interaction were not manually exercised. Both zh-CN/en-US messages are present; time formatting code is unchanged. Source logs lacking runtime results correctly remain unknown. Inferred counts represent static call sites, not loop execution counts. A changed transcript now requires an additional bounded native event scan for canonical summary counts; unchanged indexed files keep existing cache behavior.

## Records
CHANGELOG and feature inventory updated under approved TEMP. Shared history, capability and WSL contracts updated. Task remains in review for manual acceptance; no archival or automatic journal commits.
