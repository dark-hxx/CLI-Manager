import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-menu-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/desktopPetMenu.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "desktopPetMenu.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetMenu.mjs");
writeFileSync(outputPath, output, "utf8");
const menu = await import(pathToFileURL(outputPath).href);

function collapsedAt(workArea, scaleFactor, horizontal, vertical) {
  const width = Math.round(190 * scaleFactor);
  const height = Math.round(210 * scaleFactor);
  const margin = Math.round(18 * scaleFactor);
  return {
    x: horizontal === "left"
      ? workArea.x + margin
      : workArea.x + workArea.width - width - margin,
    y: vertical === "top"
      ? workArea.y + margin
      : workArea.y + workArea.height - height - margin,
    width,
    height,
  };
}

function assertGeometryWithinWorkArea(geometry, collapsed, workArea, scaleFactor) {
  assert.ok(
    Math.abs(geometry.x + geometry.anchorX * scaleFactor - collapsed.x) <= 1,
    "horizontal pet anchor must remain stable"
  );
  assert.ok(
    Math.abs(geometry.y + geometry.anchorY * scaleFactor - collapsed.y) <= 1,
    "vertical pet anchor must remain stable"
  );
  assert.ok(geometry.x >= workArea.x);
  assert.ok(geometry.y >= workArea.y);
  assert.ok(geometry.x + geometry.physicalWidth <= workArea.x + workArea.width);
  assert.ok(geometry.y + geometry.physicalHeight <= workArea.y + workArea.height);
  assert.ok(geometry.panelWidth >= 0);
  assert.ok(geometry.targetListHeight >= 0);
  assert.ok(geometry.targetListHeight <= geometry.logicalHeight - 28 + 0.001);
}

for (const scaleFactor of [1, 1.25, 1.5]) {
  test(`menu placement preserves the pet anchor at all four screen corners (DPI ${scaleFactor})`, () => {
    const workArea = { x: 0, y: 0, width: 1920 * scaleFactor, height: 1040 * scaleFactor };
    const cases = [
      ["left", "top", "right", "below"],
      ["right", "top", "left", "below"],
      ["left", "bottom", "right", "above"],
      ["right", "bottom", "left", "above"],
    ];
    for (const [
      horizontalEdge,
      verticalEdge,
      expectedHorizontalPlacement,
      expectedVerticalPlacement,
    ] of cases) {
      const collapsed = collapsedAt(workArea, scaleFactor, horizontalEdge, verticalEdge);
      const geometry = menu.calculateDesktopPetMenuWindowGeometry(
        collapsed,
        scaleFactor,
        5,
        workArea,
        34
      );
      assert.equal(geometry.horizontalPlacement, expectedHorizontalPlacement);
      assert.equal(geometry.verticalPlacement, expectedVerticalPlacement);
      assertGeometryWithinWorkArea(geometry, collapsed, workArea, scaleFactor);
    }
  });
}

test("actions-only menus also flip away from the top-left edge", () => {
  const workArea = { x: 0, y: 0, width: 1280, height: 720 };
  const collapsed = { x: 8, y: 8, width: 190, height: 210 };
  const geometry = menu.calculateDesktopPetMenuWindowGeometry(
    collapsed,
    1,
    0,
    workArea
  );
  assert.equal(geometry.horizontalPlacement, "right");
  assert.equal(geometry.verticalPlacement, "below");
  assertGeometryWithinWorkArea(geometry, collapsed, workArea, 1);
});

test("task card viewport is capped at three visible cards", () => {
  const collapsed = { x: 900, y: 600, width: 190, height: 210 };
  const threeTargets = menu.calculateDesktopPetMenuWindowGeometry(collapsed, 1, 3);
  const manyTargets = menu.calculateDesktopPetMenuWindowGeometry(collapsed, 1, 12);
  assert.equal(manyTargets.targetListHeight, threeTargets.targetListHeight);
});

test("task-only menus remove the quick-action gap and empty menus stay collapsed", () => {
  const collapsed = { x: 900, y: 600, width: 190, height: 210 };
  const fullMenu = menu.calculateDesktopPetMenuWindowGeometry(collapsed, 1, 3);
  const taskOnly = menu.calculateDesktopPetMenuWindowGeometry(
    collapsed,
    1,
    3,
    null,
    0,
    { showActionMenu: false }
  );
  const empty = menu.calculateDesktopPetMenuWindowGeometry(
    collapsed,
    1,
    0,
    null,
    0,
    { showActionMenu: false }
  );
  assert.ok(taskOnly.panelWidth < fullMenu.panelWidth);
  assert.equal(taskOnly.panelWidth, 280);
  assert.equal(empty.panelWidth, 0);
  assert.deepEqual(
    { width: empty.physicalWidth, height: empty.physicalHeight },
    { width: collapsed.width, height: collapsed.height }
  );
});

test("platform selection can retain five visible entries", () => {
  const collapsed = { x: 900, y: 600, width: 190, height: 210 };
  const taskList = menu.calculateDesktopPetMenuWindowGeometry(collapsed, 1, 5, null, 34);
  const platformList = menu.calculateDesktopPetMenuWindowGeometry(
    collapsed,
    1,
    5,
    null,
    34,
    { maxVisibleItems: 5 }
  );
  assert.ok(platformList.targetListHeight > taskList.targetListHeight);
});

test("negative-coordinate monitor work areas remain supported", () => {
  const scaleFactor = 1.25;
  const workArea = { x: -2560, y: -180, width: 2560, height: 1440 };
  const collapsed = collapsedAt(workArea, scaleFactor, "left", "bottom");
  const geometry = menu.calculateDesktopPetMenuWindowGeometry(
    collapsed,
    scaleFactor,
    4,
    workArea,
    34
  );
  assert.equal(geometry.horizontalPlacement, "right");
  assert.equal(geometry.verticalPlacement, "above");
  assertGeometryWithinWorkArea(geometry, collapsed, workArea, scaleFactor);
});

test("menu space is compressed on the larger side without moving the pet", () => {
  const scaleFactor = 1;
  const workArea = { x: 0, y: 0, width: 800, height: 300 };
  const collapsed = { x: 300, y: 50, width: 190, height: 210 };
  const geometry = menu.calculateDesktopPetMenuWindowGeometry(
    collapsed,
    scaleFactor,
    5,
    workArea,
    34,
    { maxVisibleItems: 5 }
  );
  assert.equal(geometry.horizontalPlacement, "right");
  assert.equal(geometry.verticalPlacement, "above");
  assert.equal(geometry.panelWidth, 310);
  assert.equal(geometry.physicalHeight, 260);
  assertGeometryWithinWorkArea(geometry, collapsed, workArea, scaleFactor);
});

test("without monitor data the legacy left/above direction keeps an exact anchor", () => {
  const collapsed = { x: 900, y: 600, width: 238, height: 263 };
  const scaleFactor = 1.25;
  const geometry = menu.calculateDesktopPetMenuWindowGeometry(
    collapsed,
    scaleFactor,
    3,
    null,
    34
  );
  assert.equal(geometry.horizontalPlacement, "left");
  assert.equal(geometry.verticalPlacement, "above");
  assert.ok(Math.abs(geometry.x + geometry.anchorX * scaleFactor - collapsed.x) <= 1);
  assert.ok(Math.abs(geometry.y + geometry.anchorY * scaleFactor - collapsed.y) <= 1);
});

test("live size changes preserve the pet bottom-center anchor", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const original = { x: 1600, y: 800, width: 190, height: 210 };
  const originalCenter = original.x + original.width / 2;
  const originalBottom = original.y + original.height;
  const small = menu.resizeDesktopPetCollapsedWindowBounds(original, 1, 0.4, workArea);
  const large = menu.resizeDesktopPetCollapsedWindowBounds(small, 1, 1.5, workArea);
  const restored = menu.resizeDesktopPetCollapsedWindowBounds(large, 1, 1, workArea);

  for (const bounds of [small, large, restored]) {
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - originalCenter) <= 1);
    assert.ok(Math.abs(bounds.y + bounds.height - originalBottom) <= 1);
  }
  assert.deepEqual({ width: small.width, height: small.height }, { width: 76, height: 84 });
  assert.deepEqual({ width: large.width, height: large.height }, { width: 285, height: 315 });
  assert.deepEqual(
    { width: restored.width, height: restored.height },
    { width: original.width, height: original.height }
  );
});

test("live size changes remain within negative-coordinate monitor work areas", () => {
  const workArea = { x: -2560, y: -180, width: 2560, height: 1440 };
  const collapsed = { x: -2554, y: -174, width: 190, height: 210 };
  const resized = menu.resizeDesktopPetCollapsedWindowBounds(
    collapsed,
    1.25,
    1.5,
    workArea
  );
  assert.ok(resized.x >= workArea.x);
  assert.ok(resized.y >= workArea.y);
  assert.ok(resized.x + resized.width <= workArea.x + workArea.width);
  assert.ok(resized.y + resized.height <= workArea.y + workArea.height);
});

test("latest async menu state replaces queued intermediate states", async () => {
  const calls = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const runner = menu.createLatestAsyncTaskRunner(async (value, context) => {
    calls.push({ value, context });
    if (value === "open-1") {
      markFirstStarted();
      await firstGate;
    }
  });

  runner.schedule("open-1");
  await firstStarted;
  runner.schedule("close");
  runner.schedule("open-2");
  assert.equal(calls[0].context.isLatest(), false);

  const idle = runner.whenIdle();
  releaseFirst();
  await idle;
  assert.deepEqual(calls.map((entry) => entry.value), ["open-1", "open-2"]);
  assert.equal(calls[1].context.isLatest(), true);
});

test("a failed menu transition does not block the latest desired state", async () => {
  const calls = [];
  const errors = [];
  const runner = menu.createLatestAsyncTaskRunner(
    async (value) => {
      calls.push(value);
      if (value === "broken") throw new Error("expected");
    },
    (error) => errors.push(error)
  );

  runner.schedule("broken");
  runner.schedule("open");
  await runner.whenIdle();
  assert.deepEqual(calls, ["broken", "open"]);
  assert.equal(errors.length, 1);
});
