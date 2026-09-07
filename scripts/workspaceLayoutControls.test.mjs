import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const titleBarSource = readFileSync(new URL("../src/components/WindowTitleBar.tsx", import.meta.url), "utf8");
const controlsSource = readFileSync(
  new URL("../src/components/layout/WorkspaceLayoutControls.tsx", import.meta.url),
  "utf8",
);
const menuSource = readFileSync(
  new URL("../src/components/layout/WorkspaceLayoutMenu.tsx", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(new URL("../src/components/sidebar/index.tsx", import.meta.url), "utf8");
const terminalTabsSource = readFileSync(new URL("../src/components/TerminalTabs.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(
  new URL("../src/components/settings/pages/SidebarSettingsPage.tsx", import.meta.url),
  "utf8",
);
const i18nSource = readFileSync(new URL("../src/lib/i18n.ts", import.meta.url), "utf8");

test("title-bar controls stay outside the window drag region", () => {
  assert.match(titleBarSource, /<WorkspaceLayoutControls \/>/);
  assert.match(titleBarSource, /data-tauri-drag-region/);
  assert.match(titleBarSource, /data-tauri-drag-region[\s\S]*<\/div>\s*<WorkspaceLayoutControls \/>/);
});

test("layout controls expose immediate visibility, position, and reset actions", () => {
  assert.match(controlsSource, /requestSidebarToggle/);
  assert.match(controlsSource, /requestSidebarExpand/);
  assert.match(controlsSource, /projectSidebarSide/);
  assert.match(controlsSource, /hasWorkspanTabs/);
  assert.match(controlsSource, /workspanDisabled/);
  assert.match(controlsSource, /terminalSidePanelVisible/);
  assert.match(controlsSource, /workspanTabBarVisible/);
  assert.match(menuSource, /onSetTerminalSidePanelSide/);
  assert.match(menuSource, /onSetProjectSidebarSide/);
  assert.match(menuSource, /onSetWorkspanTabBarPosition/);
  assert.match(menuSource, /onOpenAutoFocus/);
  assert.match(menuSource, /ArrowDown/);
});

test("sidebar visibility is reported through the existing local state owner", () => {
  assert.match(sidebarSource, /notifySidebarStateChange/);
  assert.match(sidebarSource, /SIDEBAR_EXPAND_REQUEST_EVENT/);
  assert.match(sidebarSource, /sidebarCollapsedRef\.current/);
});

test("panel actions reveal a hidden auxiliary region before toggling its content", () => {
  assert.equal((terminalTabsSource.match(/if \(ensureTerminalSidePanelVisible\(\)\) return;/g) ?? []).length, 6);
  assert.match(terminalTabsSource, /openFilesPanelForProject[\s\S]*ensureTerminalSidePanelVisible\(\)/);
});

test("settings no longer owns a duplicate workspace layout entry", () => {
  assert.doesNotMatch(settingsSource, /WorkspaceLayoutSection/);
  assert.equal((i18nSource.match(/"workspaceLayout\.controls\.customize":/g) ?? []).length, 2);
  assert.equal((i18nSource.match(/"workspaceLayout\.controls\.reset":/g) ?? []).length, 2);
});

test("unavailable Workspan tabs cannot trigger a no-op visibility write", () => {
  assert.match(controlsSource, /if \(!workspanEnabled \|\| !hasWorkspanTabs\) return;/);
  assert.match(controlsSource, /workspanUnavailable/);
  assert.match(i18nSource, /"workspaceLayout\.controls\.workspanUnavailable": "当前没有可用的 Workspan Tab"/);
  assert.match(i18nSource, /"workspaceLayout\.controls\.workspanUnavailable": "No Workspan tabs are currently available"/);
});
