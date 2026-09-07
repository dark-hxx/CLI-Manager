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
- OSC 7/8/133/633/777, other OSC bodies, CSI, UTF-8 bytes, output sequence/ACK semantics, replay and snapshots remain unchanged, except OSC 52 which the frontend clipboard host consumes (see OSC 52 contract below).

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
| OSC body is not exactly `10;?` or `11;?` | Preserve it byte-for-byte, except OSC 52 which the frontend clipboard host strips |

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

## Scenario: OSC 52 host clipboard

### 1. Scope / Trigger

- Trigger: a local or remote TUI writes OSC `52;Pc;Pd` (BEL or ST) or the same sequence wrapped in tmux DCS passthrough.
- The frontend display pipeline owns this sequence. Rust color-query filtering leaves OSC 52 unchanged so the React host can decode it.
- Live PTY frames may write the host clipboard. They answer `Pd=?` queries only after the user explicitly enables host clipboard reads. Replay and reset frames strip the sequence and must not write the clipboard or reply.

### 2. Contracts

- Decode `Pd` as UTF-8 Base64, accepting standard padded and unpadded payloads. Invalid, empty, or `?` payloads never write the clipboard.
- When the user setting `osc52ClipboardEnabled` is on, a live write calls `copyTextToClipboard`.
- A live query reads the host clipboard and writes `OSC 52 ; Pc ; <base64> BEL` back to the PTY only when the separate `osc52ClipboardQueryEnabled` setting is enabled. It defaults to `false` because the reply sends host clipboard contents to the local or remote process, and it is excluded from settings backup/sync so consent stays device-local.
- Query authorization is checked before queuing and again after the native clipboard read. A reply is sent only when its Base64 payload is at most `OSC52_MAX_BASE64_CHARS` (2,000,000); read and write actions share a 32-action bounded queue, dropping excess events.
- When either corresponding setting is off, sequences are still stripped. Disabling writes prevents clipboard writes; disabling queries prevents query replies.
- Query replies are allowed from React because they are clipboard host answers, not OSC 10/11 color replies.
- `mouseEventsRequireAlt` is true so host selection survives mouseup unless the user holds Alt.

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
