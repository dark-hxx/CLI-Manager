@echo off
rem URL uses percent-encoded exclamation marks before batch escaping.
setlocal EnableDelayedExpansion
set "NODE_OPTIONS=!NODE_OPTIONS! --import={{PRELOAD_URL}}"
setlocal DisableDelayedExpansion
cmd /d /v:off /s /c ^"%*^"
