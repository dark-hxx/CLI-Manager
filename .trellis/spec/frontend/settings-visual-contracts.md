# Settings visual contracts

- `SettingsModal` owns a `SettingsThemeProvider` and a `settings-scope` surface. The nested provider uses `MantineThemeProvider`, not another root-writing provider. User palette/font preferences remain authoritative.
- Shared settings UI lives in the settings feature. `SettingsSection` and `SettingsRow` own presentation only; store writes, pending-operation guards and accordion persistence stay in the owning pages.
- Navigation order and IDs remain stable. The compact Select and desktop navigation must call the same guarded `onTabChange`; do not set the active tab directly from compact navigation.
- Below 760px, show the compact category selector. Form rows use available content width (560px) rather than viewport width. Complex tables and editors own horizontal scrolling.
- Mantine Portal content receives `settings-scope` through theme classNames. Select/MultiSelect/Autocomplete replace Combobox's staticSelector, so their dropdown classes must be registered individually. Test real rendered components, not only the theme object.
- Radix dialog surfaces owned by settings carry `settings-scope settings-radix-dialog`. `DialogPresentationProvider` passes the optional scope and translated close label through React context, including `useAppConfirm` dialogs whose DOM is portaled outside settings. Shared dialogs outside the provider keep their defaults. Do not move Portals into a clipping/transforming ancestor. Preserve focus, Escape ownership and z-index.
- Selected and keyboard-focus states are separate. Use theme-derived shallow fills, single borders and a visible focus ring. Preserve error, disabled and semantic status colors; normal groups have no elevation.
- Focus traversal must exclude controls hidden by an ancestor. A child's computed `display` alone cannot establish visibility: check layout rectangles and visibility on entry and each Tab event. Keep the shell fallback when no controls are visible.
- Keep settings opaque when workspace backgrounds are active. Use inherited system/user fonts, 400/500/600 weights and font-size tokens; no remote font requirement.
- Sponsors configuration shared with the project sidebar lives in the narrow `features/settings/api/sponsors` module, without UI/state imports.

## Validation

Run `node --test scripts/settingsDialog.test.mjs scripts/settingsFocus.test.mjs scripts/settingsPresentation.test.mjs scripts/extensionsSettingsLayout.test.mjs scripts/extensionsMcpSaving.test.mjs scripts/nativeProviderCatalogSelection.test.mjs scripts/defaultThemeSettings.test.mjs scripts/workspaceBackgroundLayout.test.mjs`, frontend build, and strict architecture checks.

Per quality-guidelines.md, agents do not start application services or the desktop app for visual verification. Human checks cover light/dark and zh-CN/en-US, 1200×800/900×600/350×600, UI font 13/18px, keyboard focus, nested menus/dialogs, dirty-leave confirmation and workspace images. Static rendering is not a substitute for desktop visual acceptance.
