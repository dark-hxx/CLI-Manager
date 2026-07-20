# Terminal OSC Color Contracts

## Scenario: OSC 10/11 color-query ownership

### 1. Scope / Trigger

- Trigger: a terminal program sends OSC `10;?` or `11;?` to query the default foreground/background color.
- The Rust PTY reader owns live replies. React may filter legacy/replay queries from display output, but must never write color replies to the PTY.
- Local Windows and WSL sessions reply immediately. SSH sessions consume the query without replying because network RTT can exceed a CLI's probe timeout and turn the late reply into user input.

### 2. Signatures

```rust
pub struct TerminalColorSpec {
    pub foreground: String,
    pub background: String,
}

ClientFrame::Create {
    terminal_colors: Option<TerminalColorSpec>,
    // existing fields omitted
}

ClientFrame::SetTerminalColors {
    id: u64,
    session_id: String,
    terminal_colors: TerminalColorSpec,
}

pub fn update_terminal_colors(
    &self,
    session_id: &str,
    foreground: &str,
    background: &str,
) -> Result<(), String>;
```

The negotiated daemon feature is `terminal_colors_v1`.

### 3. Contracts

- `foreground` and `background` are strict `#RRGGBB` strings.
- `Create.terminal_colors` is optional for compatibility with an older client frame; missing/invalid colors disable replies but queries are still removed from output.
- `SetTerminalColors` is sent only when `terminal_colors_v1` is advertised. Theme changes update the existing session without recreating its PTY.
- The PTY reader first uses `safe_emit_boundary`, so OSC sequences split across OS reads remain buffered until BEL (`0x07`) or ST (`ESC \\`) arrives.
- A safe output batch may contain multiple queries. Remove all OSC 10/11 queries, preserve their order, build one reply buffer, take the shared writer lock once, `write_all`, then `flush`.
- Reply format is `ESC ] <10|11> ; rgb:RRRR/GGGG/BBBB ESC \\` using uppercase hex.
- OSC 7/8/133/633/777, other OSC bodies, CSI, UTF-8 bytes, output sequence/ACK semantics, replay and snapshots remain unchanged.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Color is not strict `#RRGGBB` | `update_terminal_colors` returns `invalid terminal foreground/background color` |
| Session does not exist | Return the existing session-not-found error |
| Color lock is poisoned | Return `terminal colors poisoned` |
| Writer lock/write/flush fails | Log a warning; keep the filtered display output flowing |
| Colors are missing on create | Consume OSC 10/11 without replying |
| Session is SSH | Consume OSC 10/11 without replying |
| OSC is incomplete | Keep it buffered through `safe_emit_boundary`; do not partially parse or reply |
| OSC body is not exactly `10;?` or `11;?` | Preserve it byte-for-byte |

### 5. Good/Base/Bad Cases

- Good: local Codex sends OSC 10 then 11 in one batch; xterm receives neither query and the PTY receives one ordered reply write.
- Base: a normal shell emits text and unrelated OSC sequences; output is unchanged.
- Good: a theme switch sends `set_terminal_colors`; the next local query uses the new colors.
- Base: replay contains historical OSC 10/11 queries; the frontend removes them with zero PTY writes.
- Bad: React calls `terminalProcessManager.write` from `useTerminalOsc` to answer a live query.
- Bad: SSH receives a locally generated reply that can arrive after the remote probe timeout.

### 6. Tests Required

- `cargo test osc_color`
  - strict color parsing;
  - BEL/ST query removal;
  - ordered combined reply;
  - missing colors and SSH produce no reply;
  - unrelated/incomplete OSC is preserved.
- `node --test scripts/terminalOsc.test.mjs scripts/ptyHostSocket.test.mjs scripts/terminalProcessManager.test.mjs`
  - frontend normalization has no PTY write path;
  - replay uses the same no-side-effect filter;
  - create/update frames carry terminal colors behind the process-manager boundary.
- `npx tsc --noEmit` and `cargo check` must pass.
- Manual matrix: PowerShell, CMD, Git Bash, WSL, SSH, reconnect/replay, and a theme change followed by a new query.

### 7. Wrong vs Correct

#### Wrong

```ts
// The WebView/daemon round trip can outlive a short CLI probe window.
terminalProcessManager.write(sessionId, formatSpecialColorReply(10, foreground));
```

#### Correct

```rust
if let Some(filtered) = filter_color_queries(safe_output, colors, !is_ssh) {
    if !filtered.reply.is_empty() {
        let mut writer = shared_writer.lock()?;
        writer.write_all(&filtered.reply)?;
        writer.flush()?;
    }
    sink.on_output(session_id, &filtered.output);
}
```
