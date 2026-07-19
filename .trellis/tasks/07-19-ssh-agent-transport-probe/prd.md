# SSH Agent transport and probe

## Goal

Shared transport spec, one-shot version/status/doctor probes, protocol negotiation, and diagnostics.

## Requirements

- Extract a shared non-PTY SSH transport specification from existing Host settings.
- Probe Agent discovery, version, status, and doctor without opening an interactive terminal.
- Handle login banners, protocol magic, timeouts, authentication-required, missing Agent, and version mismatch.
- Persist only sanitized installation metadata and diagnostics; never persist credentials.

## Acceptance Criteria

- [ ] Transport parity covers config alias, jump/proxy, agent, identity, and credential reference modes.
- [ ] Probe error classes are stable and bilingual UI states are mapped.
- [ ] Protocol framing/banner tests and Rust integration tests pass.
- [ ] Existing SSH connection testing and PTY launch regressions pass.

## Notes

- Depends on `07-19-ssh-config-root-launch`.
