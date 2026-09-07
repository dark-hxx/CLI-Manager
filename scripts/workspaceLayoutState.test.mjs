import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const layoutSource = readFileSync(new URL("../src/lib/workspaceLayout.ts", import.meta.url), "utf8");
const settingsStoreSource = readFileSync(new URL("../src/stores/settingsStore.ts", import.meta.url), "utf8");

test("workspace layout v3 persists both sidebar docks and auxiliary visibility", () => {
  assert.match(layoutSource, /version: 3/);
  assert.match(layoutSource, /projectSidebarSide: WorkspaceDockSide/);
  assert.match(layoutSource, /projectSidebarSide: "left"/);
  assert.match(layoutSource, /terminalSidePanelVisible: boolean/);
  assert.match(layoutSource, /workspanTabBarVisible: boolean/);
  assert.match(layoutSource, /terminalSidePanelVisible: true/);
  assert.match(layoutSource, /workspanTabBarVisible: true/);
  assert.match(layoutSource, /updateWorkspaceLayout/);
});

test("workspace layout migration validates every field and persists upgraded values", () => {
  assert.match(layoutSource, /raw\.projectSidebarSide === "left" \|\| raw\.projectSidebarSide === "right"/);
  assert.match(layoutSource, /typeof raw\.terminalSidePanelVisible === "boolean"/);
  assert.match(layoutSource, /typeof raw\.workspanTabBarVisible === "boolean"/);
  assert.match(settingsStoreSource, /const storedWorkspaceLayout = entries\.workspaceLayout/);
  assert.match(settingsStoreSource, /JSON\.stringify\(storedWorkspaceLayout\) !== JSON\.stringify\(workspaceLayout\)/);
  assert.match(settingsStoreSource, /persistSetting\("workspaceLayout", workspaceLayout\)/);
});
