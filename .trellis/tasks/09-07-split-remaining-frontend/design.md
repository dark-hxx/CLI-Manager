# Frontend feature decomposition

Start with existing top-level Hook settings controls/model helpers; preserve their exact
component bodies and keep parent hook ordering. Retain the legacy page export as a facade
while moving its owner to features/settings. Then separate sidebar UI responsibilities and
history store actions without creating another store or duplicating module-level caches.

Scope scenarios: both languages, local/WSL/SSH settings, installed/partial/missing Hooks,
sound validation and cancellation, collapsed sections, copy state; project/filter changes,
stale asynchronous responses and selection persistence for history/sidebar.

No new dependencies or runtime UI launch. Use TypeScript/source comparison and targeted
Node tests; final desktop visual verification remains a human checklist.
