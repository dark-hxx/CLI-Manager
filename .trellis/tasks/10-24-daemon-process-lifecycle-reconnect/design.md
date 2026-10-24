# Design

## Process identity

`connect_or_spawn` first looks for a sibling `cli-manager-daemon` executable and starts it without arguments. Source/dev builds that do not produce the helper keep the existing `__daemon` self-dispatch fallback.

## Discard shutdown

The normal shutdown command keeps routing-enabled daemons alive for background mode. Discard-and-exit uses a separate force command that stops routing, closes all daemon PTYs, and then requests shutdown. The command can recover a lost control bridge under a single async lock before cleanup.

## Reconnect recovery

Control-channel write failures and timeouts mark the client disconnected and clear pending requests. Endpoint lookup, PTY preparation, and legacy requests call the locked recovery helper; recovery reconnects to the recorded daemon or starts a replacement on a blocking worker thread.
