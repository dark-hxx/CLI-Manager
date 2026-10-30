# Cross-Platform Thinking Guide

> **Purpose**: Check platform-specific process and terminal behavior before changing shared UI or transport code.

## Terminal and CLI Output

Windows ConPTY, WSL, Bash, and local shells can expose the same process output
through different PTY implementations. A frontend cannot assume that stdout
and stderr remain separate after the process enters the PTY, or that line
endings use only one representation.

Before implementing a terminal fix:

- [ ] Trace the process output on every supported runtime in scope.
- [ ] Verify whether stdout and stderr share one PTY stream.
- [ ] Handle both `\n` and `\r\n` when matching a confirmed line-oriented diagnostic.
- [ ] Test output split at every byte/character boundary that can cross a
  frontend frame.
- [ ] Keep platform-specific handling at the nearest existing compatibility
  boundary and preserve ordinary Shell output.

For fullscreen TUIs, an extension diagnostic written outside the renderer can
arrive at the renderer's current cursor position. Put a narrowly identified,
stateful filter in the CLI's shared xterm output transform. Do not solve a
display corruption by changing PTY wiring or silently changing the CLI's
configuration unless the product requirement explicitly covers that behavior.

## Terminal Mouse Selection

- [ ] Distinguish inability to create an xterm selection from an invisible
  highlight or a native clipboard failure before changing the copy path.
- [ ] Test mouse reporting on/off, normal/alternate buffers and restored
  terminals with real mouse gestures; programmatic selection skips routing.
- [ ] Choose the selection modifier by the local browser platform, not the
  SSH/WSL process OS. xterm's macOS override requires an explicit option;
  a Windows Shift test does not prove macOS can select.
- [ ] Preserve ordinary TUI mouse/wheel reports; do not disable tracking to
  make text selection appear to work. Follow the mouse policy contract in
  [Component Guidelines](../frontend/component-guidelines.md).
- [ ] Label simulated platform branches as simulations, not native macOS
  WebKit or system clipboard acceptance.

## Good / Bad Cases

- **Good**: Windows/WSL Pi advisory, split across frames, is removed only in
  the Pi compatibility path; Shell and other CLI output remains unchanged.
- **Good**: A reset clears a partial candidate before the next session output.
- **Bad**: Treating a WSL reproduction as proof that a Windows ConPTY stream
  has separate stderr, or filtering every `MCP:` line globally.
