# Terminal Output Scheduling Contracts

## Scenario: Bounded and fair live terminal output

### 1. Scope / Trigger

- Trigger: changing PTY reader delivery, daemon output aggregation, WebSocket output frames, `useTerminalDisplay`, xterm write scheduling, or output ACK behavior.
- Goal: sustained output from one or more mounted terminals must not monopolize the WebView main thread.

### 2. Signatures

```rust
fn output_batch_would_overflow(pending_bytes: usize, next_bytes: usize) -> bool;
```

```ts
interface ScheduledTerminalWrite {
  token: symbol;
  isVisible: () => boolean;
  flush: () => void;
}
```

### 3. Contracts

- Daemon live output aggregation uses a 64 KiB budget and only combines complete chunks already emitted by `safe_emit_boundary`.
- If adding the next safe chunk would exceed the budget, emit the current batch and carry the next chunk into the following batch.
- A single pre-existing safe chunk is never split in the daemon; an abnormal oversized control sequence may therefore exceed the target budget rather than corrupt ANSI/UTF-8 state.
- All mounted terminals share one frontend scheduler. Each animation frame starts at most one xterm write batch.
- Visible terminals have priority, limited to three consecutive batches while hidden work is pending; hidden terminals must then receive one turn.
- When the document is hidden, pending terminal writes use a timer fallback instead of depending only on `requestAnimationFrame`; the visible path keeps rAF and a watchdog timer, and `visibilitychange` reschedules the pending entry. A fallback callback cancels the other scheduled handle before consuming work.
- Per-terminal FIFO, Replay/Reset barriers, and frame ownership stay in `useTerminalDisplay`.
- `TerminalOutputDelivery.commit()` and daemon ACK happen only after the matching xterm write callback.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| 32 KiB pending + 32 KiB next | Combine into one live frame |
| 40 KiB pending + 40 KiB next | Emit pending; carry next |
| One safe chunk exceeds 64 KiB | Preserve the chunk; do not split ANSI/UTF-8 state |
| Two terminals become ready in one browser frame | Start only one xterm write |
| Visible output remains continuous while hidden output waits | Run at most three visible batches before one hidden batch |
| Document is hidden or rAF is stalled | Timer fallback eventually starts the pending xterm write |
| Display is reset or disposed while queued | Remove its scheduler token and never flush it later |
| Replay or Reset reaches the frontend queue | Preserve the existing barrier and commit order |

### 5. Good / Base / Bad Cases

- Good: three live terminals remain responsive; visible output advances first and hidden buffers continue advancing without starvation.
- Base: one terminal retains the existing FIFO and callback-based ACK behavior with one extra global scheduling hop.
- Bad: every terminal owns an independent RAF and all callbacks start large xterm writes in the same browser frame.

### 6. Tests Required

- Rust: assert 32+32 KiB fits and 40+40 KiB overflows the aggregation budget.
- Frontend: assert two displays start only one write per animation frame.
- Frontend: assert continuous visible output yields to a hidden display after three batches.
- Existing Replay, Reset, resize, visibility, TUI color sync, TypeScript, `cargo fmt`, and `cargo check` validations remain required.

### 7. Wrong vs Correct

#### Wrong

```rust
pending.extend_from_slice(&next);
if pending.len() >= OUTPUT_BUFFERING_MAX_BYTES {
    emit(pending); // already exceeded the budget
}
```

```ts
requestAnimationFrame(flushThisTerminal); // one independent RAF per terminal
```

#### Correct

```rust
if output_batch_would_overflow(pending.len(), next.len()) {
    carry(next);
    emit(pending);
} else {
    pending.extend_from_slice(&next);
}
```

```ts
requestGlobalTerminalWrite({ token, isVisible, flush });
```
