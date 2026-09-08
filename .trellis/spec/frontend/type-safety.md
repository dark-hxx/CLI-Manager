# Type Safety

## Scope

Use this file as the stable type-safety entry referenced by existing tasks. Detailed rules live with
their owning contracts instead of being duplicated here.

## Contracts

- Run `npx tsc --noEmit` for frontend type validation.
- Keep IPC payload keys and persisted setting shapes aligned with the relevant domain contract.
- Validate persisted compound values through the migration/normalization patterns in
  [State Management](./state-management.md).
- Follow shared type ownership and cross-feature import boundaries in
  [AI Architecture Contracts](./ai-architecture-contracts.md).
- Do not silence contract mismatches with `any` or unchecked assertions; fix the owner or add a
  narrow boundary validator where external data enters the application.
