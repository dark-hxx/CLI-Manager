# Design

## Scope

Frontend-first routing surface cleanup with one small backend IPC addition for editing the persisted preferred listener port. Existing takeover, failover, queue, proxy, rectifier, optimizer, and daemon contracts remain the source of truth.

## UI structure

- `NativeProviderRoutingSection` owns one compact local-service accordion item.
- The local-service panel contains service enable, app-specific takeover, and app-specific failover enable switches.
- Takeover label is derived from the selected app type: “接管 {app} 路由” / “Take over {app} routing”.
- Failover content is rendered only when the selected app has a matching takeover. It is an accordion item, collapsed initially, and contains the queue plus failover parameters/circuit reset controls.
- Queue rows show provider name, current/ready/in-queue/degraded badges as applicable, queue position, and the queue switch. In-queue and ready states use distinct colors. Queued rows have in-place up/down priority controls. UUIDs, key counts, and the separate health accordion are removed.
- Listener, daemon runtime, proxy, rectifier, and optimizer stay as advanced collapsed items. The listener item adds a preferred-port input and save action.
- The sidebar routing quick control and its setting are no longer rendered or offered by this surface. Persisted legacy values remain harmless for compatibility.
- Queue membership changes are applied optimistically in the local state and rolled back on IPC failure, avoiding a full-list loading refresh.
- Provider catalog refreshes keep the existing list visible, and selecting the default provider no longer forces the list to scroll, so switching between catalog/Home/routing does not jump the page.
- The provider settings page keeps its last app type, Catalog/Home/Routing surface, detail tab, selected provider, and outer scroll position in the existing in-memory page cache. The failover row renders the current route provider as an explicit localized “In use” badge.
- Resetting failover circuits also returns the active route provider to the first ready provider in saved queue order.
- Daemon logs expose the actual candidate order and every skip/attempt/result, including stream completion and final provider selection, so a healthy provider cannot appear silently skipped during diagnosis.
- Codex Responses streaming records circuit success only after `response.completed`; an upstream error event, early EOF, read error, or timeout before completion records a circuit failure. A request that has already returned streaming headers is not replayed mid-stream; the next request can skip the degraded provider.
- A streaming failure opens the failed provider circuit immediately, so CLI reconnect attempts do not repeat the same failed provider several times. When a later queued provider succeeds, it becomes the current provider and is promoted to the front of the next request's eligible queue while preserving the saved queue order for the remaining providers.
- Persisted routing enablement is treated as desired state while the daemon status is authoritative at runtime; refresh/re-enable reconciles an enabled-but-stopped daemon, and the UI only enables takeover/failover controls while the listener is actually running.

## State and data flow

- Reuse `useNativeProviderRouting` for routing state/actions.
- Add a narrow `routing_set_preferred_port` command accepting an integer port. Rust validates the existing service config constraints and persists it only while the service is stopped and no takeover remains, so changing the port cannot leave existing Home projections pointing at a stale endpoint. The next service start uses the saved port.
- The frontend keeps a local port draft and only sends it on explicit save; refresh resets the draft from persisted state.
- Failover visibility and enablement are derived from selected app takeover plus daemon capability/connection. Existing backend failover validation remains authoritative.
- Scoped Codex launches write a generated non-secret profile beside the selected real Codex Home and use `--profile`; older snapshots keep the `-c` fallback. Claude continues to use generated settings with `--settings`.

## Compatibility and i18n

- No schema migration; service setting schema remains `routing.service.v1`.
- Add all new labels, descriptions, errors, and aria labels to both locale maps.
- Keep existing error-code parsing and localized generic routing errors.

## Risk

- Port changes while running can affect existing takeovers. The backend must preserve the current listener/takeover projection contract or fail and restore the prior listener/config.
- UI-only removal of quick controls must not delete persisted settings or break older stored settings.
