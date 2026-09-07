import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const sidebarSource = readFileSync(new URL("../src/components/sidebar/index.tsx", import.meta.url), "utf8");
const headerSource = readFileSync(new URL("../src/components/sidebar/SidebarHeader.tsx", import.meta.url), "utf8");
const controlsSource = readFileSync(
  new URL("../src/components/layout/WorkspaceLayoutControls.tsx", import.meta.url),
  "utf8",
);
const menuSource = readFileSync(
  new URL("../src/components/layout/WorkspaceLayoutMenu.tsx", import.meta.url),
  "utf8",
);
const layoutSource = readFileSync(new URL("../src/lib/workspaceLayout.ts", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../src/styles/workspace-layout.css", import.meta.url), "utf8");

test("project sidebar docking is persisted and applied to the main workspace order", () => {
  assert.match(layoutSource, /projectSidebarSide: WorkspaceDockSide/);
  assert.match(layoutSource, /raw\.projectSidebarSide === "left" \|\| raw\.projectSidebarSide === "right"/);
  assert.match(appSource, /workspaceLayout\.projectSidebarSide/);
  assert.match(appSource, /data-project-sidebar-side=\{projectSidebarSide\}/);
  assert.match(appSource, /dockSide=\{projectSidebarSide\}/);
  assert.match(stylesSource, /data-project-sidebar-side="right"[^}]*> \.ui-sidebar-shell/);
  assert.match(stylesSource, /data-project-sidebar-side="right"[^}]*> \.ui-main-shell/);
});

test("right-docked project sidebar keeps its resize affordance facing the terminal", () => {
  assert.match(sidebarSource, /dockSide\?: WorkspaceDockSide/);
  assert.match(sidebarSource, /dockSide === "right" \? window\.innerWidth - clientX : clientX/);
  assert.match(sidebarSource, /data-sidebar-side=\{dockSide\}/);
  assert.match(sidebarSource, /dockSide === "right" \? "left-0" : "right-0"/);
  assert.match(headerSource, /dockSide: WorkspaceDockSide/);
  assert.match(headerSource, /dockSide === "right"/);
});

test("layout menu exposes independent project and terminal auxiliary docking choices", () => {
  assert.match(controlsSource, /onSetProjectSidebarSide/);
  assert.match(controlsSource, /projectSidebarSide={projectSidebarSide}/);
  assert.match(menuSource, /workspaceLayout\.controls\.sidebarLeft/);
  assert.match(menuSource, /workspaceLayout\.controls\.sidebarRight/);
  assert.match(menuSource, /onSetProjectSidebarSide\("left"\)/);
  assert.match(menuSource, /onSetProjectSidebarSide\("right"\)/);
  assert.match(menuSource, /onSetTerminalSidePanelSide\("left"\)/);
  assert.match(menuSource, /onSetTerminalSidePanelSide\("right"\)/);
});
