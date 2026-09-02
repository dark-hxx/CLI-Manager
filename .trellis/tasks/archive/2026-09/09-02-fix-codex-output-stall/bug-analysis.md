# Bug Analysis: Issue #245 Review Follow-ups

## 1. Root Cause Category

- **Category**: B / D — Cross-Layer Contract and Test Coverage Gap
- **Specific Cause**: The first daemon recovery implementation treated the
  attach replay representation as a live-output representation, did not turn
  a truncated retained sequence into a reset boundary, and performed spool
  reads inside the global client fan-out lock. The frontend/daemon contract
  distinguishes snapshots, raw PTY events, and reconnect reset semantics, but
  the recovery path and tests did not enforce all three boundaries together.

## 2. Why the First Fix Was Incomplete

1. **Shared replay accessor**: `replay_frames()` correctly included a
   checkpoint for attach, but `output_frames_after()` reused it for live
   flushing. A full xterm snapshot could therefore be appended as ordinary
   output.
2. **Missing truncation boundary**: the first retained sequence was filtered
   to non-empty output before continuity was checked, so a discarded prefix
   could be silently accepted as a valid suffix.
3. **Over-wide lock scope**: ACK recovery held `clients` while rereading and
   cloning the spool, so one large recovery could delay output fan-out for
   unrelated sessions.

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Contract | Separate checkpoint-bearing attach replay from raw live-frame recovery; never append checkpoints to an existing terminal. | DONE |
| P0 | Runtime | Check all retained event sequences, including empty resize events, before live flush; close a stale client when the raw sequence has a gap and let reconnect use `replay_reset`. | DONE |
| P0 | Architecture | Snapshot bounded spool data outside the global clients lock and keep paused state until the ordered enqueue completes. | DONE |
| P1 | Tests | Cover checkpoint exclusion, truncated-window reconnect behavior, high-watermark recovery, and slow-client isolation. | DONE |

## 4. Systematic Expansion

- **Similar Issues**: Any path that converts `Attached.replay` or checkpoint
  data into `Output` frames; any ACK or reconnect path that reads a session
  spool while holding a global registry/fan-out lock.
- **Design Improvement**: Treat snapshot replay, raw event replay, and live
  delivery as distinct types/operations even when they share `ReplayFrame`
  storage. Sequence continuity must be checked before filtering metadata-only
  events.
- **Process Improvement**: Cross-layer review must test both normal retained
  recovery and the buffer-truncated branch, then inspect lock scope around all
  disk-backed replay reads.

## 5. Knowledge Capture

- [x] Updated `.trellis/spec/backend/pty-daemon-contracts.md` with checkpoint,
  sequence-gap, reconnect-reset, and lock-scope contracts.
- [x] Updated `.trellis/spec/guides/cross-layer-thinking-guide.md` with the
  snapshot/live replay and global-lock failure patterns.
- [x] Confirmed no `src/templates/markdown/spec/` mirror exists in this
  checkout, so no template synchronization is applicable.
