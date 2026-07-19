# SSH Agent bridge runtime

## Goal

Per-host reusable bridge manager, framing, heartbeat, reconnect, subscriptions, and shutdown.

## Requirements

- Maintain at most one reusable Agent bridge per active Host/client while PTY sessions remain independent.
- Implement handshake, capabilities, request IDs, cancellation, heartbeat, backpressure, reconnect, epoch, and graceful shutdown.
- Route Hook, history, files, Git, and stats over the shared bridge.
- Stop retry loops for authentication-required and incompatible protocol states.

## Acceptance Criteria

- [ ] Multiple projects/tabs on one Host still create one bridge.
- [ ] Banner contamination, oversized frames, duplicate sequence, timeout, cancellation, and reconnect tests pass.
- [ ] Ten-host/forty-PTY connection accounting meets the documented target.
- [ ] App shutdown and Host deletion release or block bridge state correctly.

## Notes

- Depends on `07-19-ssh-agent-transport-probe`.
