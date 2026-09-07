import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tabsSource = readFileSync(new URL("../src/components/TerminalTabs.tsx", import.meta.url), "utf8");
const frameSource = readFileSync(
  new URL("../src/components/terminal/ResizableTerminalPanelFrame.tsx", import.meta.url),
  "utf8",
);
const storageSource = readFileSync(
  new URL("../src/lib/terminalPanelStorage.ts", import.meta.url),
  "utf8",
);
const workspaceFrameSource = readFileSync(
  new URL("../src/components/terminal/TerminalWorkspaceFrame.tsx", import.meta.url),
  "utf8",
);
const sidePanelSource = readFileSync(
  new URL("../src/components/terminal/TerminalSidePanel.tsx", import.meta.url),
  "utf8",
);
const storeSource = readFileSync(new URL("../src/stores/settingsStore.ts", import.meta.url), "utf8");
const syncSource = readFileSync(new URL("../src/lib/syncSettings.ts", import.meta.url), "utf8");
const controlsSource = readFileSync(
  new URL("../src/components/layout/WorkspaceLayoutControls.tsx", import.meta.url),
  "utf8",
);
const menuSource = readFileSync(
  new URL("../src/components/layout/WorkspaceLayoutMenu.tsx", import.meta.url),
  "utf8",
);
const layoutSource = readFileSync(new URL("../src/lib/workspaceLayout.ts", import.meta.url), "utf8");
const i18nSource = readFileSync(new URL("../src/lib/i18n.ts", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../src/styles/workspace-layout.css", import.meta.url), "utf8");
const componentStylesSource = readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");

test("workspace layout persists validated auxiliary-panel side and visibility settings", () => {
  assert.match(storeSource, /workspaceLayout: WorkspaceLayoutSettings/);
  assert.match(storeSource, /workspaceLayout: \{ \.\.\.WORKSPACE_LAYOUT_DEFAULTS \}/);
  assert.match(storeSource, /const storedWorkspaceLayout = entries\.workspaceLayout/);
  assert.match(layoutSource, /terminalSidePanelVisible: boolean/);
  assert.match(layoutSource, /workspanTabBarVisible: boolean/);
  assert.match(syncSource, /workspaceLayout: "preferences"/);
  assert.match(controlsSource, /terminalSidePanelVisible/);
});

test("docking keeps panels next to the terminal and moves the action rail to the outer edge", () => {
  assert.match(tabsSource, /panels=\{\[/);
  assert.match(tabsSource, /key="merged"/);
  assert.match(tabsSource, /key="stats"/);
  assert.match(workspaceFrameSource, /<Fragment key="workspace-panels">\{orderedPanels\}<\/Fragment>/);
  assert.match(workspaceFrameSource, /<Fragment key="workspace-center">\{children\}<\/Fragment>/);
  assert.match(workspaceFrameSource, /dockSide === "left" && <Fragment key="workspace-actions">\{actions\}<\/Fragment>/);
  assert.match(workspaceFrameSource, /dockSide === "right" && <Fragment key="workspace-actions">\{actions\}<\/Fragment>/);
  assert.match(workspaceFrameSource, /dockSide === "left" && panelSlot/);
  assert.match(workspaceFrameSource, /dockSide === "right" && panelSlot/);
  assert.match(tabsSource, /data-dock-side=\{terminalSidePanelSide\}/);
  assert.match(tabsSource, /popoverSide=\{terminalSidePanelSide === "left" \? "right" : "left"\}/);
  assert.match(tabsSource, /BackgroundTasksPanel[\s\S]*?popoverSide=\{terminalSidePanelSide === "left" \? "right" : "left"\}/);
});

test("merged and independent panels share the direction-aware resizable frame", () => {
  assert.match(sidePanelSource, /ResizableTerminalPanelFrame/);
  assert.match(sidePanelSource, /dockSide=\{dockSide\}/);
  assert.match(tabsSource, /<ResizableTerminalPanelFrame[\s\S]*?dockSide=\{terminalSidePanelSide\}/);
  assert.match(frameSource, /dockSide === "left"[\s\S]*event\.clientX - dragStartXRef\.current/);
  assert.match(frameSource, /dragStartXRef\.current - event\.clientX/);
  assert.match(frameSource, /if \(rawWidth !== nextWidth\)/);
  assert.match(frameSource, /readLegacyTerminalPanelWidth/);
  assert.match(storageSource, /localStorage\.getItem/);
  assert.match(frameSource, /data-dock-side=\{dockSide\}/);
  assert.match(frameSource, /dockedOnLeft \? "right-0 translate-x-1\/2" : "left-0 -translate-x-1\/2"/);
});

test("left panel separators stay on the edge facing the terminal and hidden panels reclaim space", () => {
  assert.match(stylesSource, /.ui-terminal-well > \.ui-terminal-side-panel-frame\[data-dock-side="left"\]/);
  assert.match(stylesSource, /box-shadow: inset -1px 0 0/);
  assert.match(stylesSource, /data-terminal-side-panel-visible="false"/);
  assert.match(componentStylesSource, /ui-terminal-action-sidebar\[data-dock-side="left"\]/);
  assert.doesNotMatch(stylesSource, /ui-terminal-workspace-frame/);
});

test("workspace layout controls and reset copy are localized", () => {
  assert.match(menuSource, /workspaceLayout\.controls\.reset/);
  assert.match(menuSource, /workspaceLayout\.controls\.customize/);
  assert.match(i18nSource, /"workspaceLayout\.controls\.customize": "自定义工作区布局"/);
  assert.match(i18nSource, /"workspaceLayout\.controls\.customize": "Customize workspace layout"/);
});
