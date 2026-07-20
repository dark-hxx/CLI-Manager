# Implementation Plan

1. Add pure Rust OSC color-query scanner and unit tests for complete, split, malformed, mixed and SSH/no-reply cases.
2. Share the PTY writer safely and integrate scanner/replies into live reader output.
3. Extend Create protocol with initial colors and add a runtime color-update frame.
4. Resolve current terminal colors in the frontend create path and synchronize later theme changes.
5. Remove frontend OSC reply writes while preserving query filtering and existing shell integration parsing.
6. Update Node/Rust regression tests, contracts and `[TEMP]` changelog.
7. Run focused tests, TypeScript check, cargo check, diff validation and GitNexus change detection.
