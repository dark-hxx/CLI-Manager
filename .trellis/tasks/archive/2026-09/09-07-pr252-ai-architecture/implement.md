# Implementation Plan

1. Synchronize `master`, pin PR #252 head, create task records, and merge `origin/master`.
2. Resolve conflicts by contract; repair protocol, database, Git safety, accessibility, and tests.
3. Validate and merge PR #252 through GitHub CLI with the verified head SHA.
4. Add architecture governance scripts/specs and capture a shrinking offender baseline.
5. Split frontend i18n/styles, terminal, Git, and remaining feature modules in bounded batches.
6. Split Rust app/infrastructure, history/catalog, provider/hook/statusline/daemon/SSH modules.
7. Run architecture, TypeScript, Rust workspace, SSH-agent, and targeted/full test gates.
8. Update `TEMP` changelog and feature inventory, detect graph changes, and archive tasks.
