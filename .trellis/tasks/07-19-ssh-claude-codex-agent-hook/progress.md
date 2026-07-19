# SSH Agent Integration Shard Progress

Each shard is implemented sequentially in the main session. A shard cannot advance until its focused checks pass; broader cross-layer regression checks run again after dependent shards are integrated.

| Order | Child task | Status | Focused verification |
|---|---|---|---|
| S01 | `07-19-ssh-config-root-launch` | verified, commit pending | migration, TS type-check, SSH launch Rust tests |
| S02 | `07-19-ssh-agent-transport-probe` | pending | transport parity, probe/error classification, protocol tests |
| S03 | `07-19-ssh-agent-install-supply-chain` | pending | signature/hash/target/install/rollback tests |
| S04 | `07-19-ssh-remote-hook-lifecycle` | pending | adapter merge, ownership, atomicity, spool tests |
| S05 | `07-19-ssh-agent-bridge-runtime` | pending | one-bridge invariant, reconnect, cancellation, shutdown tests |
| S06 | `07-19-ssh-remote-history-indexing` | pending | parser/index/catalog/cursor/offline tests |
| S07 | `07-19-ssh-remote-history-resume` | pending | preflight/ownership/cwd/config-root routing tests |
| S08 | `07-19-ssh-remote-file-panel` | pending | confinement/read limits/provider routing tests |
| S09 | `07-19-ssh-remote-git-panel` | pending | porcelain/diff/repo identity/read-only boundary tests |
| S10 | `07-19-ssh-stats-release-verification` | pending | stats/performance/security/i18n/docs/full regression |

## Validation Gates

1. Focused gate: tests closest to the changed module plus formatting for touched Rust files.
2. Boundary gate: frontend-to-Rust payload validation, remote/local routing, credential and path confinement review.
3. Regression gate: `npx tsc --noEmit`, relevant Rust crate tests, and existing SSH tests.
4. Integration gate: dependent shard scenarios, connection-count checks, stale/offline behavior, and bilingual UI review.
5. Release gate: full allowed quality commands, change-scope audit, README/feature inventory/`[TEMP]` changelog review.
