# Simplify local routing and provider queue UI

## Changelog Target

`[TEMP]`

## Goal

Make the native provider routing page readable by putting routing prerequisites and controls in one place, hiding technical identifiers, and showing failover only when it can actually be used.

## Confirmed facts

- The routing surface currently has separate accordion items for local routing service, listener, takeover, and daemon runtime.
- Provider Home takeover currently lives in its own routing accordion item.
- Automatic failover is a standalone `Paper` below the routing accordion, with its own queue and a separate health/circuit accordion.
- Queue rows currently show provider name, UUID, key summary, current/ready badges, and a switch.
- The sidebar has a persisted local-routing quick control backed by `showLocalQuickControl`.
- Backend behavior requires the local routing daemon to be running before takeover succeeds; enabling takeover does not itself start the daemon. Enabling automatic failover requires a takeover and a usable daemon, and seeds the current provider when the queue is empty.
- User-visible strings must be updated in both `zh-CN` and `en-US` through i18n.

## Requirements

- Move the current Provider Home takeover switch into the “Local routing service” block and label it as “Take over {app} routing”, with `{app}` changing with the selected Claude/Codex/Grok type.
- Put the automatic-failover enable switch into the “Local routing service” block.
- Remove the local-routing sidebar quick switch and its settings switch; no duplicate quick control remains.
- Show the “Automatic failover” block only after the current app has a takeover. Keep it collapsed by default and make the whole block collapsible.
- Simplify the provider queue: show provider name and only the actionable/status information needed to decide whether it is in the queue; do not show provider UUIDs or verbose key summaries.
- Merge health/degraded status into each provider queue row; do not render a separate health/degraded section.
- Keep control dependencies explicit: takeover requires local routing service enabled; automatic failover requires takeover and available runtime; disabling takeover must not leave an enabled failover state.
- Preserve existing routing/failover persistence and backend contracts unless the UI dependency cannot be implemented correctly without a backend change.
- Keep listener/daemon status, outbound proxy, rectifier, and optimizer as advanced collapsible blocks; listener preferred port must be editable by the user and saved through the existing routing configuration path.
- Distinguish queued providers from merely ready providers, allow queued priority to move up/down in place, and keep project-scoped Codex/Claude launch syntax as `--profile` / `--settings`.
- Keep all new/changed UI copy localized in Chinese and English.

## Acceptance Criteria

- [ ] Routing page has one compact “Local routing service” block containing service enable, current Home takeover, and automatic failover enable controls.
- [ ] Takeover and failover switches are disabled with a clear localized reason when their prerequisites are missing.
- [ ] Automatic failover is absent before takeover and appears as a collapsed accordion after takeover.
- [ ] Failover queue contains no UUID, key-count sentence, or separate health accordion; each provider row includes its queue switch and health/degraded status when available.
- [ ] Failover queue distinguishes `In queue` from `Ready`, and queued providers can move up/down without leaving the page.
- [ ] Main workspace has a provider-routing navigation entry without adding another routing toggle.
- [ ] Scoped Codex/Claude project launches use `--profile` / `--settings` respectively.
- [ ] Sidebar and settings no longer expose a local-routing quick switch.
- [ ] Existing queue ordering, failover settings, takeover behavior, and circuit reset behavior remain functional.
- [ ] Listener preferred port can be edited while the service and takeovers are stopped, persisted, and validated; invalid or unavailable values surface a localized error without claiming the service is running.
- [ ] `zh-CN` and `en-US` both render the changed controls without hardcoded copy.
- [ ] Type-check and focused Rust/frontend checks pass.

## Planning decision

Advanced routing details remain available but start collapsed. The listener block exposes preferred port as a numeric input; save/restart behavior stays explicit and backend validation remains authoritative.

## Resolved product decision

Keep “enable local routing” and “take over {app} routing” as separate controls in the “Local routing service” block. The former starts the daemon listener; the latter applies the local endpoint to the selected app's current Home and records that takeover. The takeover label changes with the selected app type. Automatic failover depends on both controls.
