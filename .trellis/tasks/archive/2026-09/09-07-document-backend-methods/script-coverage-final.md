# Non-Rust backend/build script coverage

## Included scope

The inventory contains 141 tracked script-like files. 52 files are in scope: backend resources, build/release/install entry points, and tests that directly exercise backend/build or process-boundary contracts. The 89 remaining files are frontend-only UI/state/rendering tests; their callbacks do not implement backend or build behavior and are explicitly excluded below.

The machine-readable callable evidence is in `script-verification.jsonl`. Its 45 changed JS/TS files contain 425 AST callables and 423 new ordinary comments; the two-count difference is deliberate because one adjacent pair in `architecture.mjs` and one in `dev-server.mjs` each share a single unambiguous group explanation. All 45 files parse and their comment-stripped ASTs match HEAD after CRLF/LF normalization.

Shell coverage: `install-ssh-agent.sh` has 11 named functions and `terminalOsc52.clipboard.e2e.sh` has 4, each with a Chinese function explanation; all three tracked shell files pass `bash -n`. `test-install-ssh-agent.sh` has no host-side named function. PowerShell parsing finds zero function definitions in `package-portable.ps1`. The other included zero-callable files are top-level orchestration only.

Included files:

- `.github/scripts/build-ssh-agent-release.mjs`
- `.github/scripts/extract-changelog.js`
- `.github/scripts/prepare-r2-release.mjs`
- `.github/scripts/prepare-r2-release.test.mjs`
- `.github/scripts/r2-release-config.mjs`
- `.github/scripts/r2-release-config.test.mjs`
- `.github/scripts/test-install-ssh-agent.sh`
- `scripts/architecture.mjs`
- `scripts/architecture.test.mjs`
- `scripts/architecture/core.mjs`
- `scripts/architecture/rust.mjs`
- `scripts/architectureRust.test.mjs`
- `scripts/codexAppServerProxy.e2e.test.mjs`
- `scripts/decodeOsc52Stream.mjs`
- `scripts/desktopPetStatus.test.mjs`
- `scripts/desktopPetTransport.test.mjs`
- `scripts/dev-server.mjs`
- `scripts/fileExplorerRefreshController.test.mjs`
- `scripts/fileExplorerWslGitRefresh.test.mjs`
- `scripts/gitDiffGenerationOptions.test.mjs`
- `scripts/gitDiffLargePerformance.test.mjs`
- `scripts/gitHistory.test.mjs`
- `scripts/gitStoreRemote.test.mjs`
- `scripts/gitTransportLease.test.mjs`
- `scripts/helpers/readComposedSource.mjs`
- `scripts/historyContentSort.test.mjs`
- `scripts/historyListRefreshState.test.mjs`
- `scripts/historySelectionPersistence.test.mjs`
- `scripts/historySmartTitleIpc.test.mjs`
- `scripts/install-ssh-agent.sh`
- `scripts/linuxGraphics.test.mjs`
- `scripts/opencodeHook.test.mjs`
- `scripts/package-portable.ps1`
- `scripts/prepare-bundle-binaries.mjs`
- `scripts/ptyHostSocket.test.mjs`
- `scripts/resourceDiagnosticsLog.test.mjs`
- `scripts/sshAgentRelease.test.mjs`
- `scripts/sshCodexSessionBinding.test.mjs`
- `scripts/sshRemoteFileContext.test.mjs`
- `scripts/sshToolIntegration.test.mjs`
- `scripts/tauri-cli.mjs`
- `scripts/tauriCliDevProxy.test.mjs`
- `scripts/terminalExitCleanup.test.mjs`
- `scripts/terminalExitTask.test.mjs`
- `scripts/terminalImageAddonCsp.test.mjs`
- `scripts/terminalOsc52.clipboard.e2e.sh`
- `scripts/terminalProcessManager.test.mjs`
- `scripts/terminalReplay.test.mjs`
- `scripts/verify-macos-window-controls.mjs`
- `scripts/wslImagePaste.test.mjs`
- `src-tauri/resources/opencode/cli-manager-hook.js`
- `vite.config.ts`

## Explicit exclusions

These files test frontend components, hooks, stores, layouts, rendering, input behavior or frontend-only helpers. They may mention an IPC name or inspect a Rust path as a static assertion, but contain no handwritten backend/build implementation callable owned by this task:

- `scripts/agentCapabilities.test.mjs`
- `scripts/agentTerminal.test.mjs`
- `scripts/appStartupLongMigration.test.mjs`
- `scripts/cliArgsHistory.test.mjs`
- `scripts/codexManualInput.test.mjs`
- `scripts/configModalShellPrefill.test.mjs`
- `scripts/desktopPetMenuGeometry.test.mjs`
- `scripts/desktopPetRenderedBounds.test.mjs`
- `scripts/desktopPetSize.test.mjs`
- `scripts/dragInteraction.test.mjs`
- `scripts/externalSessionSyncPolicy.test.mjs`
- `scripts/fileEditorMarkdownNavigation.test.mjs`
- `scripts/fileEditorTabContextMenu.test.mjs`
- `scripts/fileExplorerIgnore.test.mjs`
- `scripts/fileExplorerPathActions.test.mjs`
- `scripts/fileExplorerProjectState.test.mjs`
- `scripts/frontendFoundation.test.mjs`
- `scripts/gitDiffEditorPin.test.mjs`
- `scripts/gitDiffInteractionA11y.test.mjs`
- `scripts/gitDiffReviewNavigation.test.mjs`
- `scripts/gitDiffSettings.test.mjs`
- `scripts/gitDiffThemeWorkflow.test.mjs`
- `scripts/gitDiffViewerArchitecture.test.mjs`
- `scripts/gitDiffWorkspace.test.mjs`
- `scripts/gitGraphLayout.test.mjs`
- `scripts/gitPowerToolsSafety.test.mjs`
- `scripts/gitWorkspace.test.mjs`
- `scripts/grokHistoryFrontend.test.mjs`
- `scripts/groupPath.test.mjs`
- `scripts/historyConversationView.test.mjs`
- `scripts/historyConversionState.test.mjs`
- `scripts/historyMarkdownRendering.test.mjs`
- `scripts/historyProjectPaths.test.mjs`
- `scripts/historyResumeCommand.test.mjs`
- `scripts/historyResumeProject.test.mjs`
- `scripts/historySessionIdentity.test.mjs`
- `scripts/historySubagentHierarchy.test.mjs`
- `scripts/kimiHistoryFrontend.test.mjs`
- `scripts/kimiHookFrontend.test.mjs`
- `scripts/markdownNavigation.test.mjs`
- `scripts/markdownRendering.test.mjs`
- `scripts/nativeProviderCatalogSelection.test.mjs`
- `scripts/nativeProviderConfigView.test.mjs`
- `scripts/nativeProviderDetailView.test.mjs`
- `scripts/nativeProviderGlobalView.test.mjs`
- `scripts/nativeProviderImportDisplay.test.mjs`
- `scripts/openCodeTuiClipboard.test.mjs`
- `scripts/projectCapabilities.test.mjs`
- `scripts/projectLoadPolicy.test.mjs`
- `scripts/projectSidebarDocking.test.mjs`
- `scripts/remoteHandoff.test.mjs`
- `scripts/replayProgressModel.test.mjs`
- `scripts/resumeCliArgs.test.mjs`
- `scripts/sidebarExternalTerminalMenu.test.mjs`
- `scripts/systemFonts.test.mjs`
- `scripts/terminalBackgroundLayout.test.mjs`
- `scripts/terminalCliSession.test.mjs`
- `scripts/terminalComposerNewline.test.mjs`
- `scripts/terminalContextMenuClear.test.mjs`
- `scripts/terminalFileLinks.test.mjs`
- `scripts/terminalHookBinding.test.mjs`
- `scripts/terminalImeAnchor.test.mjs`
- `scripts/terminalImeComposition.test.mjs`
- `scripts/terminalImeInputDedup.test.mjs`
- `scripts/terminalMarkdownPreview.test.mjs`
- `scripts/terminalMouseInteraction.test.mjs`
- `scripts/terminalNewlineShortcut.test.mjs`
- `scripts/terminalOsc.test.mjs`
- `scripts/terminalOsc52.test.mjs`
- `scripts/terminalPaneMarker.test.mjs`
- `scripts/terminalPiCompatibility.test.mjs`
- `scripts/terminalPreviewTheme.test.mjs`
- `scripts/terminalReflowPolicy.test.mjs`
- `scripts/terminalRemountSnapshot.test.mjs`
- `scripts/terminalResizeDebouncer.test.mjs`
- `scripts/terminalResizeRenderBarrier.test.mjs`
- `scripts/terminalRuntime.test.mjs`
- `scripts/terminalScrollToBottom.test.mjs`
- `scripts/terminalSidePanelLayout.test.mjs`
- `scripts/terminalSplitLayout.test.mjs`
- `scripts/terminalStatsPanel.test.mjs`
- `scripts/terminalTuiColorSync.test.mjs`
- `scripts/terminalVisibility.test.mjs`
- `scripts/terminalWorkspan.test.mjs`
- `scripts/workspaceBackgroundLayout.test.mjs`
- `scripts/workspaceLayoutControls.test.mjs`
- `scripts/workspaceLayoutState.test.mjs`
- `scripts/workspanTabBarLayout.test.mjs`
- `scripts/xtermCharMeasureStyle.test.mjs`

## Embedded programs

Host-side ordinary Rust comments cover 16 embedded callables without modifying generated strings: PowerShell `global:prompt` and `global:PSConsoleHostReadLine`, Bash `__cli_manager_prompt`, PowerShell `Decode-Base64Utf8`, the Pi TypeScript helpers/callbacks, and the Live Server browser polling IIFE/callbacks. The Rust token verifier therefore remains strict and generated program text is byte-identical to HEAD.
