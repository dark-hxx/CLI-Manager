import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sidebar = readFileSync(new URL("../src/features/projects/components/SidebarView.tsx", import.meta.url), "utf8");
const projectMenu = sidebar.match(
  /\{contextMenu\.kind === "project"[\s\S]*?\{contextMenu\.kind === "worktree"/,
)?.[0];

test("project context menu exposes an explicit external terminal action only when needed", () => {
  assert.ok(projectMenu, "project context menu block should exist");
  assert.match(projectMenu, /void handleOpen\(contextMenu\.project\)/);
  assert.match(
    projectMenu,
    /!compactMode && !useExternalTerminal && !showProjectBatchContextMenu[\s\S]*?void openProjectExternally\(\[contextMenu\.project\]\)[\s\S]*?t\("sidebar\.menu\.openExternalTerminal"\)/,
  );
});

test("worktree context menu does not gain the project external terminal action", () => {
  const worktreeMenu = sidebar.match(
    /\{contextMenu\.kind === "worktree"[\s\S]*?\{contextMenu\.kind === "group"/,
  )?.[0];

  assert.ok(worktreeMenu, "worktree context menu block should exist");
  assert.doesNotMatch(worktreeMenu, /openProjectExternally/);
});
