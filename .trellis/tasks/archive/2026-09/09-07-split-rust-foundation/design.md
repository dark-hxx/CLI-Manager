# Rust foundation extraction

Separate cfg(test) bodies into sibling module directories with `mod tests;`, preserving
the same Rust module identity, private parent access and test names. Runtime code is byte-
identical outside module declarations. Existing tests remain handwritten and subject to limits.

Next extract named app/infrastructure responsibilities from lib, daemon, proxy, provider and
database owners. Keep the current crate root exports and command registration stable until
the final feature-first relocation. Public IPC, serde, SQL and process behavior do not change.

Scenario matrix: dev/installed storage, local/WSL/SSH, restart/reconnect and concurrent requests
are covered by existing tests, not changed by the module-only extraction.
