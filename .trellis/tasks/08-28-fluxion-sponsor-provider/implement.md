# Fluxion AI token 中转站入口与默认供应商实施清单

## Frontend

- [x] Add a shared `FLUXION_REGISTER_URL` constant and local image references.
- [x] Extend settings tab typing/order/persistence with `sponsors`.
- [x] Render a localized sponsor page with Fluxion banner, logo, benefit copy,
      CTA, fixed registration URL, and opener failure toast.
- [x] Add an animated, keyboard-accessible sidebar token-station button in both
      expanded and collapsed footer layouts, with reduced-motion CSS.
- [x] Add the Fluxion registration CTA and small description below the API key
      input when editing the built-in Fluxion provider.
- [x] Add matching `zh-CN`/`en-US` translations and verify `zh-TW` conversion.

## Backend

- [x] Add an idempotent `ensure_builtin_fluxion_providers` transaction to
      provider database initialization for Claude, Codex, and GrokBuild.
- [x] Keep built-in records first by initial sort index, `is_current = 0`, empty
      key table, stable IDs, and preserve all existing rows on re-initialization.
- [x] Add database regression tests for fresh, repeated, and existing-provider
      initialization.

## Records and verification

- [x] Update `CHANGELOG.md` under version `TEMP` and the matching section in
      `docs/功能清单.md`.
- [x] Run `npx tsc --noEmit`, `npm run build`, `cargo check`, and focused Rust
      database tests.
- [x] Run GitNexus `detect_changes` and review the affected symbols before
      delivery.
