# Design

Integrate the three child fixes across all 12 registered history sources. Preserve unsupported capability boundaries, exact session identity, and the zero-debt architecture gate.

## Shared contracts
Agent adapters extract native fields; shared history observation logic owns classification, identities and aggregation. Observed counts remain exact; inferred call sites carry provenance and do not establish health. Metadata uses existing catalog extension JSON, parser versions invalidate derived rows. WSL history carries distro in canonical UNC cwd; PTY launch translates to explicit --distribution/--cd and a host-valid cwd.

## Scope
Claude, Codex, Gemini, Copilot, Antigravity, Grok, Kimi, Pi, OpenCode, Kiro, Cursor, Cline. Diagnostic adapters: Claude/Codex/Pi/Grok/OpenCode. Resume builders: Claude/Codex/Pi/Grok/Kimi/OpenCode. No new runtime collector or dependency.

## Risks
Shared health reaches local/WSL/SSH. Reindex derived catalog without changing transcripts. Do not modify unowned worktrees.
