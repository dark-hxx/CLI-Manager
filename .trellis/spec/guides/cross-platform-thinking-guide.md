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

## Good / Bad Cases

- **Good**: Windows/WSL Pi advisory, split across frames, is removed only in
  the Pi compatibility path; Shell and other CLI output remains unchanged.
- **Good**: A reset clears a partial candidate before the next session output.
- **Bad**: Treating a WSL reproduction as proof that a Windows ConPTY stream
  has separate stderr, or filtering every `MCP:` line globally.
