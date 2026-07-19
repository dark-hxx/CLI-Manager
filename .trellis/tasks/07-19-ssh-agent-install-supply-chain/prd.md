# SSH Agent install supply chain

## Goal

SSH upload install plus signed HTTPS installer, upgrade, uninstall, discovery record, and artifact verification.

## Requirements

- Support explicit Agent install/upgrade/uninstall through SSH upload.
- Support user-run HTTPS installer scripts using the same signed manifest and artifacts.
- Verify target, version, signature, SHA-256, install path, permissions, and discovery record.
- Never install while saving/testing a Host or opening a project.

## Acceptance Criteria

- [ ] Linux x64/aarch64 and unsupported-target paths are tested.
- [ ] Tampered manifest, artifact, redirect, archive path, and symlink cases are rejected.
- [ ] Install, upgrade, partial failure, rollback, discovery, and uninstall tests pass.
- [ ] UI presents explicit preview/confirmation and bilingual diagnostics.

## Notes

- Depends on `07-19-ssh-agent-transport-probe`.
