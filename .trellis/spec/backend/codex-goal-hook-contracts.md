# Codex Goal Hook Compatibility

## 1. Scope / Trigger

Codex Stop is turn-scoped. Installed and development executables may coexist; a running CLI can still invoke an older Hook executable while its receiving daemon and WebView use newer code.

## 2. Signatures

- `lookup_stop_goal(session_id, wsl_distro_name) -> CodexGoalMetadata`
- `legacy_goal::enrich(&mut ClaudeHookRequest, lookup)`
- Wire fields: optional `goalStatus`, `goalId`; database query selects `goal_id, status` by exact `thread_id`.

## 3. Contracts

- The client reads the database; authenticated local HTTP admission additionally enriches legacy Codex Stop requests with missing/null goal status after validation and event-ID deduplication, before any sink receives the payload.
- Existing status, including explicit unknown, is authoritative and never overwritten by receiver lookup.
- Receiver lookup applies only to local events with a session ID. WSL distro, WSL UNC/Linux cwd on Windows, remote identity or non-local environment excludes host database lookup.
- A matching goal row supplies its status and ID. No row means unknown at the receiver: its default Home cannot prove the old client's custom Home has no goal.
- Active/unknown suppress completion; complete permits completion; paused/blocked indicate attention; limits indicate failure. All sinks consume the same enriched payload.
- Do not migrate or write Codex databases, replay old completion notifications into live sessions, or terminate daemons with live PTYs during verification.

## 4. Validation & Error Matrix

| Input | Expected behavior |
| --- | --- |
| Old local Stop + exact complete row | Forward complete and goal ID |
| Old local Stop + active row | Forward active; no completion |
| Old local Stop + missing/failed database or no row | Unknown; no completion |
| New Stop with goalStatus | Preserve metadata; no extra query |
| SSH/WSL or another CLI/event | No host query |

## 5. Good/Base/Bad Cases

- Good: old client → new bridge → complete row → enriched daemon/App/dispatcher payload.
- Base: new client already supplies active; receiver preserves it even if its own database differs.
- Bad: treat null fields as permanently running despite an exact local terminal row, or interpret no row in the receiver's default Home as confirmed no goal.

## 6. Tests Required

- Legacy null/missing field deserialization and serialized forwarding for all supported goal states.
- No-query assertions for existing metadata, non-Stop/non-Codex, missing session, SSH and WSL.
- No-row/failure remain unknown.
- Runtime validation must inspect the actual Hook executable, receiving process and recorded payload; compiling code alone does not prove a running daemon uses that code.

## 7. Wrong vs Correct

Wrong: verify only the new client and assume all running CLI sessions send the same fields.

Correct: capture client output with an isolated loopback sink, compare it to the recorded real event, and test legacy admission before the common fan-out.
