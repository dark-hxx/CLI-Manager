# SSH stats integration and release verification

## Goal

Realtime and historical usage integration, performance/security matrix, bilingual docs, changelog, and final regression checks.

## Requirements

- Integrate current-Tab remote model/token/cache/cost/reasoning stats and historical usage analysis.
- Use transcript-derived facts as authority; Hook is lifecycle/binding only and ccusage is optional validation.
- Verify connection, resource, security, compatibility, provider-isolation, i18n, and stale/offline matrices.
- Update README, `[TEMP]` changelog, and `docs/功能清单.md` only for delivered behavior.

## Acceptance Criteria

- [ ] Realtime updates are throttled and hidden tabs reduce or stop subscriptions.
- [ ] Multi-host partial-offline stats and cache freshness are explicit.
- [ ] Provider settings never probe or switch remote providers.
- [ ] Type-check, Rust checks/tests, focused frontend tests, GitNexus fallback change audit, bilingual UI review, and documentation review pass.

## Notes

- Depends on all preceding shards.
