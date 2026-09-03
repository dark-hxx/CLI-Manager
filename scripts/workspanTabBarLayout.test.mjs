import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tabsSource = readFileSync(new URL("../src/components/TerminalTabs.tsx", import.meta.url), "utf8");
const tabBarSource = readFileSync(
  new URL("../src/components/workspace/WorkspanTabBar.tsx", import.meta.url),
  "utf8",
);
const settingsSource = readFileSync(
  new URL("../src/components/settings/pages/WorkspaceLayoutSection.tsx", import.meta.url),
  "utf8",
);
const stylesSource = readFileSync(new URL("../src/styles/workspace-layout.css", import.meta.url), "utf8");
const i18nSource = readFileSync(new URL("../src/lib/i18n.ts", import.meta.url), "utf8");
const layoutSource = readFileSync(new URL("../src/lib/workspaceLayout.ts", import.meta.url), "utf8");

test("top-level Workspan tabs use one direction-aware document-flow slot", () => {
  assert.equal((tabsSource.match(/<WorkspanTabBar/g) ?? []).length, 1);
  assert.match(tabsSource, /className="ui-workspan-terminal-body"/);
  assert.match(tabsSource, /data-workspan-tabbar-position=\{workspanTabBarPosition\}/);
  assert.match(tabBarSource, /<SortableContext/);
  assert.match(tabBarSource, /data-workspan-tabbar-position=\{position\}/);
  assert.match(stylesSource, /.ui-workspan-terminal-body\[data-workspan-tabbar-position="bottom"\]/);
  assert.match(stylesSource, /flex-direction: column-reverse/);
});

test("bottom overflow list opens toward the terminal content", () => {
  assert.match(tabBarSource, /side=\{position === "bottom" \? "top" : "bottom"\}/);
  assert.match(tabBarSource, /onWheel=\{\(event\) =>/);
  assert.match(tabBarSource, /WORKSPAN_TABBAR_END_DROP_ID/);
});

test("the persisted layout contract keeps top as the default and validates bottom", () => {
  assert.match(layoutSource, /workspanTabBarPosition: WorkspanTabBarPosition/);
  assert.match(layoutSource, /workspanTabBarPosition: "top"/);
  assert.match(layoutSource, /raw\.workspanTabBarPosition === "bottom"/);
  assert.match(settingsSource, /settings\.workspaceLayout\.workspanTabBarPosition\.label/);
  assert.match(settingsSource, /TAB_POSITION_OPTIONS/);
  assert.match(settingsSource, /settings\.workspaceLayout\.reset/);
  assert.match(i18nSource, /"settings\.workspaceLayout\.tab\.top": "顶部"/);
  assert.match(i18nSource, /"settings\.workspaceLayout\.tab\.bottom": "Bottom"/);
});

test("pane-level terminal tab ownership remains outside the top-level docking slot", () => {
  const paneTabBarSource = readFileSync(new URL("../src/components/TerminalTabs.tsx", import.meta.url), "utf8");
  assert.match(paneTabBarSource, /function SortableTab\(/);
  assert.match(paneTabBarSource, /function PaneTabBar\(/);
  assert.doesNotMatch(tabBarSource, /SplitTerminalView|PaneTabBar/);
});
