# Statusline Editor Contracts

## 1. Scope / Trigger

- Applies to the Settings > Statusline designer, Claude widget editor, Codex native item editor, and terminal-style preview.

## 2. Signatures

    type StatuslineEditorSource = "claude" | "codex";
    interface StatuslinePreviewState { themeId: string; width: number }

`StatuslinePreview` accepts rendered text, preview state, change callback, empty text and aria label.

## 3. Contracts

- Claude and Codex drafts, selected items and preview state are independent.
- Claude catalog must not keep a separate target-line selector: clicking a catalog item adds it to the explicitly active line, while dragging derives the target line and position from the actual drop target; invalid drops are no-ops. Every placed widget has a direct remove action, and selected widgets can move across lines without requiring drag-and-drop.
- Clicking the selected Claude widget again or clicking empty layout space clears the selection and restores global properties.
- Claude/Codex statusline sorting must use the project's `@dnd-kit` PointerSensor pattern, not HTML5 `draggable`; Tauri `dragDropEnabled` intercepts native WebView drag/drop on Windows. Claude dragging must accept empty line containers and show the current target line before drop.
- Tool switching must not copy or normalize one tool's configuration into the other.
- Claude and Codex keep independent named profile lists. Switching one tool's active profile must not affect the other tool.
- Profile save and switch apply immediately. Switching away from a dirty draft requires save/discard/cancel handling; the active profile cannot be deleted.
- On first adoption, the editor displays the parsed actual configuration instead of replacing it with defaults. Valid external drift is offered as a new profile and never silently overwrites the active snapshot.
- Whole-library import/export is shared at page level. Import conflicts are resolved per profile before a single commit, and import never auto-switches the active profile.
- Claude preview consumes backend ANSI output; Codex preview consumes ordered official placeholder values.
- Claude install/uninstall calls pass `ccSwitchDbPath: settings.ccSwitchDbPath ?? undefined`. A returned `invalidDb`, `unavailable` or `syncFailed` state shows a localized warning while keeping the successful local install/uninstall result.
- Preview preserves Powerline private-use glyphs, uses the normalized terminal font family, and parses ANSI16, ANSI256 and TrueColor sequences without substituting plain triangle characters. Powerline Select dropdown options and selected input values must both use a compatible symbol font; selected inputs need a targeted `!important` override because the global UI font rule also targets `input` elements.
- Application-internal Powerline rendering must load the bundled `SymbolsNerdFontMono-Regular.ttf` through CSS `@font-face`. System font installation and registry detection only serve external terminals and must not be treated as proof that WebView2 can resolve the font family.
- Preview values include localized status names. Claude live output uses Chinese short labels from the shared Rust renderer; Codex native labels remain non-configurable and are not changed by the preview.
- The Codex editor catalog mirrors the current official status-line ids, including `reasoning`, `hostname`, `run-state`, `thread-credits`, `estimated-thread-cost`, `thread-id` and `workspace-headline`; official legacy aliases are normalized before they reach the editor, while unsupported ids remain actionable configuration errors.
- Codex preview is rendered directly below the Codex native statusline title/path header and before the selected/available item editors.
- Color selectors show a swatch plus persistent Chinese and English names. Powerline settings expose font status/install, enablement, alignment, theme continuation, separator, caps and theme selection.
- Successful Powerline font installation shows a localized restart-CLI-Manager notice so the system and WebView font caches can fully refresh.
- Claude preview renders each backend newline as a separate terminal row; preview-only payload fixtures must provide deterministic values for environment-dependent widgets such as Git status.
- Preview theme defaults to the current terminal theme and may temporarily select any `TERMINAL_THEME_PRESETS` entry without changing global terminal settings.
- Editor surfaces use project semantic variables (`--surface-container-*`, `--on-surface-*`, `--primary`, `--interactive-*`); provider colors are badges only.
- Layout is three columns at wide widths, two columns with a full-width property panel at medium widths, and one column on narrow widths.

## 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| Preview width outside 60–180 | Clamp to the supported range |
| Unknown ANSI code | Preserve text and ignore unsupported style |
| Unknown Codex item loaded | Keep its id visible so the user can remove it |
| Save fails | Keep draft and dirty indicator; show localized toast |
| CC Switch common-config sync fails | Keep the new local installed state and show a localized warning; do not show the operation as fully failed |
| No items selected | Show localized empty preview |

## 5. Good/Base/Bad Cases

- Good: switching app palettes recolors all editor surfaces while the preview remains on its selected terminal theme.
- Base: an unchanged config disables Save and shows no dirty badge.
- Bad: hard-coded black/white cards become unreadable in light or warm themes.
- Bad: switching from Claude to Codex discards the Claude draft.

## 6. Tests Required

- Type-check source switching, preview props and persisted source setting.
- Type-check the statusline install/uninstall payload and `StatuslineStatus.ccSwitch` response.
- Verify dirty state before/after save and after save failure.
- Verify Codex drag ordering and Claude cross-line ordering.
- Smoke-test dark, light, warm and high-contrast application palettes plus light/dark terminal preview themes.
- Verify keyboard controls, focus rings and localized aria labels.
- Verify the bundled Powerline font resource resolves from the production CSS path and renders `E0B0/E0B2/E0B4/E0B6/E0B8/E0BA/E0BC/E0BE` without requiring a system-installed font.

## 7. Wrong vs Correct

### Wrong

    <Card className="bg-black text-white" />

### Correct

    <Card className="bg-surface-container-low text-on-surface" />
