import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-split-layout-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/terminal/browser/TerminalSplitLayout.ts", import.meta.url),
  "utf8",
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "TerminalSplitLayout.ts",
}).outputText;
const modulePath = join(tempDir, "TerminalSplitLayout.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const {
  alignTerminalSplitRootRect,
  buildTerminalSplitLayout,
  observeTerminalSplitPixelRatio,
} = await import(pathToFileURL(modulePath).href);

function assertDevicePixelAligned(value, devicePixelRatio) {
  const deviceValue = value * devicePixelRatio;
  assert.ok(
    Math.abs(deviceValue - Math.round(deviceValue)) < 1e-9,
    `${value}px is not aligned at DPR ${devicePixelRatio}`,
  );
}

function leaf(id) {
  return { type: "leaf", id, sessionIds: [], activeSessionId: null };
}

test("root bounds are aligned to the current display's physical pixel grid", () => {
  const bounds = { left: 100.25, top: 48.125, right: 1300.75, bottom: 848.375 };
  const devicePixelRatio = 2;
  const rect = alignTerminalSplitRootRect(bounds, devicePixelRatio);

  assertDevicePixelAligned(bounds.left + rect.left, devicePixelRatio);
  assertDevicePixelAligned(bounds.top + rect.top, devicePixelRatio);
  assertDevicePixelAligned(bounds.left + rect.left + rect.width, devicePixelRatio);
  assertDevicePixelAligned(bounds.top + rect.top + rect.height, devicePixelRatio);
});

test("1080p DPR 1 splits use integer CSS coordinates", () => {
  const originLeft = 100.25;
  const originTop = 48.125;
  const devicePixelRatio = 1;
  const rect = alignTerminalSplitRootRect(
    { left: originLeft, top: originTop, right: 1300.75, bottom: 848.375 },
    devicePixelRatio,
  );
  const tree = {
    type: "split",
    id: "root",
    direction: "horizontal",
    ratio: 0.443,
    first: leaf("left"),
    second: leaf("right"),
  };
  const layout = buildTerminalSplitLayout(tree, rect, null, {
    originLeft,
    originTop,
    devicePixelRatio,
  });

  for (const item of [...layout.leaves, ...layout.dividers]) {
    assertDevicePixelAligned(originLeft + item.rect.left, devicePixelRatio);
    assertDevicePixelAligned(originTop + item.rect.top, devicePixelRatio);
    assertDevicePixelAligned(originLeft + item.rect.left + item.rect.width, devicePixelRatio);
    assertDevicePixelAligned(originTop + item.rect.top + item.rect.height, devicePixelRatio);
  }
});

test("2K displays at 125% and 150% scaling keep every pane edge physically aligned", () => {
  for (const devicePixelRatio of [1.25, 1.5]) {
    const originLeft = 73.2;
    const originTop = 41.4;
    const rect = alignTerminalSplitRootRect(
      { left: originLeft, top: originTop, right: 1510.6, bottom: 941.8 },
      devicePixelRatio,
    );
    const tree = {
      type: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.443,
      first: leaf("left"),
      second: leaf("right"),
    };
    const layout = buildTerminalSplitLayout(tree, rect, null, {
      originLeft,
      originTop,
      devicePixelRatio,
    });

    for (const item of [...layout.leaves, ...layout.dividers]) {
      assertDevicePixelAligned(originLeft + item.rect.left, devicePixelRatio);
      assertDevicePixelAligned(originTop + item.rect.top, devicePixelRatio);
      assertDevicePixelAligned(originLeft + item.rect.left + item.rect.width, devicePixelRatio);
      assertDevicePixelAligned(originTop + item.rect.top + item.rect.height, devicePixelRatio);
    }
  }
});

test("moving between Retina and 1080p displays rebinds the DPR observer", () => {
  const mediaQueries = [];
  const target = {
    devicePixelRatio: 2,
    matchMedia: (query) => {
      const listeners = new Set();
      const mediaQuery = {
        query,
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
        emit: () => [...listeners].forEach((listener) => listener()),
        listenerCount: () => listeners.size,
      };
      mediaQueries.push(mediaQuery);
      return mediaQuery;
    },
  };
  let changes = 0;
  const dispose = observeTerminalSplitPixelRatio(target, () => { changes += 1; });

  assert.equal(mediaQueries[0].query, "(resolution: 2dppx)");
  target.devicePixelRatio = 1;
  mediaQueries[0].emit();
  assert.equal(changes, 1);
  assert.equal(mediaQueries[0].listenerCount(), 0);
  assert.equal(mediaQueries[1].query, "(resolution: 1dppx)");

  dispose();
  assert.equal(mediaQueries[1].listenerCount(), 0);
});

test("arbitrary horizontal split ratios keep both panes on physical pixels", () => {
  const originLeft = 100.25;
  const originTop = 48.125;
  const devicePixelRatio = 2;
  const rect = alignTerminalSplitRootRect(
    { left: originLeft, top: originTop, right: 1300.75, bottom: 848.375 },
    devicePixelRatio,
  );
  const tree = {
    type: "split",
    id: "root",
    direction: "horizontal",
    ratio: 0.427,
    first: leaf("left"),
    second: leaf("right"),
  };
  const layout = buildTerminalSplitLayout(tree, rect, null, {
    originLeft,
    originTop,
    devicePixelRatio,
  });
  const [leftPane, rightPane] = layout.leaves;
  const [divider] = layout.dividers;

  for (const item of [leftPane, rightPane, divider]) {
    assertDevicePixelAligned(originLeft + item.rect.left, devicePixelRatio);
    assertDevicePixelAligned(originTop + item.rect.top, devicePixelRatio);
    assertDevicePixelAligned(originLeft + item.rect.left + item.rect.width, devicePixelRatio);
    assertDevicePixelAligned(originTop + item.rect.top + item.rect.height, devicePixelRatio);
  }
  assert.equal(leftPane.rect.left + leftPane.rect.width, divider.rect.left);
  assert.equal(divider.rect.left + divider.rect.width, rightPane.rect.left);
  assert.equal(rightPane.rect.left + rightPane.rect.width, rect.left + rect.width);
});

test("nested horizontal and vertical splits stay aligned after a drag preview", () => {
  const originLeft = 17.2;
  const originTop = 31.4;
  const devicePixelRatio = 1.5;
  const rect = alignTerminalSplitRootRect(
    { left: originLeft, top: originTop, right: 1018.1, bottom: 732.3 },
    devicePixelRatio,
  );
  const tree = {
    type: "split",
    id: "root",
    direction: "horizontal",
    ratio: 0.5,
    first: leaf("left"),
    second: {
      type: "split",
      id: "nested",
      direction: "vertical",
      ratio: 0.5,
      first: leaf("top-right"),
      second: leaf("bottom-right"),
    },
  };
  const layout = buildTerminalSplitLayout(tree, rect, { splitId: "nested", ratio: 0.613 }, {
    originLeft,
    originTop,
    devicePixelRatio,
  });

  for (const item of [...layout.leaves, ...layout.dividers]) {
    assertDevicePixelAligned(originLeft + item.rect.left, devicePixelRatio);
    assertDevicePixelAligned(originTop + item.rect.top, devicePixelRatio);
    assertDevicePixelAligned(originLeft + item.rect.left + item.rect.width, devicePixelRatio);
    assertDevicePixelAligned(originTop + item.rect.top + item.rect.height, devicePixelRatio);
  }
});
