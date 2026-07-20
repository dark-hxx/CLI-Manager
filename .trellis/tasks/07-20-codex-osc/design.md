# Design

## Data Flow

```text
settingsStore terminal theme
  -> TerminalCreateRequest initial colors
  -> PtyHost Create frame
  -> Daemon handle_create
  -> PtyManager session color state

runtime theme change
  -> PtyHost SetTerminalColors frame
  -> PtyManager updates session color state

PTY output
  -> streaming OSC scanner
  -> local/WSL: remove query + serialized immediate writer reply
  -> SSH: remove query, no reply
  -> remaining output -> daemon sink -> frontend -> xterm
```

## Contracts

- Colors use validated `#RRGGBB` strings at the frontend boundary and normalized RGB bytes in Rust.
- Only exact, terminated OSC `10;?` and `11;?` queries are consumed.
- BEL and ST terminators are supported; incomplete sequences remain buffered across PTY reads.
- Non-color OSC, malformed queries and ordinary output remain byte-for-byte unchanged.
- All writes, including user input and automatic replies, share one mutex-protected writer to preserve order.
- Replay is downstream of live PTY capture and cannot invoke the scanner or writer.
- `ssh_launch.is_some()` disables replies while still consuming OSC color queries.

## Writer Ownership

Change `PtySession.writer` to a shared writer handle. The reader thread receives a clone only for serialized automatic replies. Public `write_bytes` uses the same lock, preventing interleaved writes.

## Runtime Theme Updates

Add a daemon client frame to update per-session colors. `XTermTerminal` sends updates when the resolved terminal colors change. Updates do not touch PTY input until a future OSC query is received.

## Failure Behavior

- Invalid/missing colors: consume queries without replying.
- Writer failure during automatic reply: log once through the existing PTY logging path; continue delivering output.
- Oversized unterminated control sequence: preserve the existing boundary overflow behavior.

## Compatibility

- Protocol additions use serde defaults for Create colors so a stale field omission remains parseable.
- Existing OSC shell integration remains in the frontend.
- No dependency or Tauri command signature expansion beyond optional fields.
