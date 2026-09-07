# Historical Incident: `provider_database_query_failed`

## Root cause

An earlier native-provider prototype reused an already-applied provider
migration version. Existing user databases recorded v25 for legacy
`providers/provider_keys`, while the prototype queried later
`managed_*` tables that were not present. The UI reduced the missing-table
query to `provider_database_query_failed`.

## Preserved lesson

- Never change, remove, or reuse the SQL/checksum of an applied migration.
- A provider schema with CCS-compatible `providers` names must not be added
  to the existing `cli-manager.db`, which already has historical provider
  tables.
- The new provider domain uses its own `providers.db`; historical v25/v26
  migration registrations remain in the app database solely for startup
  compatibility.

## Verification for the rebuild

1. Open an existing application database with v25/v26 history.
2. Open/create the separate provider database.
3. Confirm provider-domain commands never query historical
   `managed_*` tables.
4. Confirm a malformed/missing provider database yields a provider-domain
   error without preventing the application database or CCS read-only page
   from opening.
