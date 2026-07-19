# SSH remote Hook lifecycle

## Goal

Claude/Codex hook adapters, preview/install/upgrade/uninstall, third-party preservation, and spool behavior.

## Requirements

- Implement Claude and Codex Hook discovery, preview, install, upgrade, uninstall, and conflict diagnostics.
- Keep Hook state independent from history availability while sharing the same tool config root.
- Preserve third-party configuration and remove only CLI-Manager-owned records.
- Make one-shot Hook execution fast and non-blocking with bounded spool fallback.

## Acceptance Criteria

- [ ] JSON/TOML merge, malformed config, symlink, concurrent edit, atomic replace, and rollback tests pass.
- [ ] Claude-only, Codex-only, both, absent Agent, and offline spool cases pass.
- [ ] Owner/install identity prevents deleting third-party or another installation's entries.
- [ ] Hook latency, quota, TTL, deduplication, and gap behavior are verified.

## Notes

- Depends on `07-19-ssh-agent-install-supply-chain`.
