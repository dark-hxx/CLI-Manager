import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/lib/terminalIme.ts", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-ime-composition-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

function transpile(relativePath, outputName, replacements = {}) {
  let output = ts.transpileModule(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      fileName: outputName.replace(/\.mjs$/, ".ts"),
    },
  ).outputText;
  for (const [from, to] of Object.entries(replacements)) {
    output = output.replaceAll(`from "${from}"`, `from "${to}"`);
  }
  const outputPath = join(tempDir, outputName);
  writeFileSync(outputPath, output, "utf8");
  return outputPath;
}

transpile("../src/lib/terminalTui.ts", "terminalTui.mjs");
transpile(
  "../src/lib/terminalImeAnchor.ts",
  "terminalImeAnchor.mjs",
  { "./terminalTui": "./terminalTui.mjs" },
);
const terminalImePath = transpile(
  "../src/lib/terminalIme.ts",
  "terminalIme.mjs",
  { "./terminalImeAnchor": "./terminalImeAnchor.mjs" },
);
const { attachTerminalIme } = await import(pathToFileURL(terminalImePath).href);

test("IME composition-end cleanup waits for xterm to commit the textarea value", () => {
  const handler = source.match(
    /const onCompositionEnd = \(\) => \{([\s\S]*?)\n  \};/,
  )?.[1];

  assert.ok(handler, "onCompositionEnd handler was not found");
  assert.match(handler, /lastCompositionEndAt = nowForImeInput\(\);/);
  assert.match(
    handler,
    /compositionEndCleanupTimerId = window\.setTimeout\(\(\) => \{[\s\S]*?onCompositionCommitted\(textarea\?\.value \?\? ""\);[\s\S]*?scheduleHelperTextareaAnchorPin\(\);[\s\S]*?scheduleFit\(true\);[\s\S]*?\}, 0\);/,
  );

  const timerIndex = handler.indexOf("window.setTimeout");
  assert.ok(timerIndex >= 0);
  assert.ok(handler.indexOf("scheduleHelperTextareaAnchorPin()") > timerIndex);
  assert.ok(handler.indexOf("scheduleFit(true)") > timerIndex);
});

test("composition anchoring restores the width from the frozen input cursor", () => {
  const handler = source.match(
    /const applyCompositionAnchorFix = \(\) => \{([\s\S]*?)\n  \};/,
  )?.[1];

  assert.ok(handler, "applyCompositionAnchorFix handler was not found");
  assert.match(
    handler,
    /const maxWidth = String\(Math\.max\(1, terminal\.cols - anchor\.x\) \* cell\.width\) \+ "px";/,
  );

  const maxWidthIndex = handler.indexOf("compositionView.style.maxWidth = maxWidth");
  const boundsIndex = handler.indexOf("compositionView?.getBoundingClientRect()");
  assert.ok(maxWidthIndex >= 0);
  assert.ok(boundsIndex > maxWidthIndex);
});

test("IME textarea and composition view can use separate anchors", () => {
  const handler = source.match(
    /const applyCompositionAnchorFix = \(\) => \{([\s\S]*?)\n  \};/,
  )?.[1];

  assert.ok(handler, "applyCompositionAnchorFix handler was not found");
  assert.match(handler, /const textareaAnchor = resolveTextareaAnchor\?\.\(terminal, anchor\) \?\? anchor;/);
  assert.match(handler, /compositionView\.style\.top = top;/);
  assert.match(handler, /textarea\.style\.top = textareaTop;/);
  assert.match(handler, /textarea\.style\.left = textareaLeft;/);
});

test("a new composition or disposal cancels stale deferred cleanup", () => {
  assert.match(
    source,
    /const onCompositionStart = \(\) => \{[\s\S]*?window\.clearTimeout\(compositionEndCleanupTimerId\);[\s\S]*?isComposingRef\.current = true;/,
  );
  assert.match(
    source,
    /if \(compositionEndCleanupTimerId !== null\) window\.clearTimeout\(compositionEndCleanupTimerId\);[\s\S]*?\n  \};\n\};/,
  );
});

test("terminal resize invalidates the frozen composition anchor", () => {
  assert.match(
    source,
    /const resizeDisposable = terminal\.onResize\(\(\) => \{[\s\S]*?if \(!isComposingRef\.current\) \{[\s\S]*?scheduleHelperTextareaAnchorPin\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?compositionAnchorCell = null;[\s\S]*?scheduleCompositionAnchorFix\(\);[\s\S]*?\}\);/,
  );
  assert.match(source, /resizeDisposable\.dispose\(\);/);
});

test("idle helper textarea uses the CLI-specific anchor before composition starts", () => {
  const handler = source.match(
    /const pinHelperTextareaAnchor = \(\) => \{([\s\S]*?)\n  \};/,
  )?.[1];

  assert.ok(handler, "pinHelperTextareaAnchor handler was not found");
  assert.match(handler, /const anchor = resolveCompositionAnchorCell\(\);/);
  assert.match(handler, /const textareaAnchor = resolveTextareaAnchor\?\.\(terminal, anchor\) \?\? anchor;/);
  assert.match(handler, /textarea\.style\.left = String\(Math\.max\(0, textareaAnchor\.x \* cell\.width\)\) \+ "px";/);
  assert.match(handler, /textarea\.style\.top = String\(Math\.max\(0, textareaAnchor\.y \* cell\.height\)\) \+ "px";/);
});

test("composition anchor resolver runs after the generic fallback", () => {
  assert.match(
    source,
    /const fallbackAnchor = resolveTerminalImeCompositionAnchor\(terminal\);[\s\S]*?return resolveCompositionAnchor\?\.\(terminal, fallbackAnchor\) \?\? fallbackAnchor;/,
  );
});

test("Process key synchronously restores the helper textarea before composition starts", () => {
  const listeners = new Map();
  const textareaListeners = new Map();
  const terminalListeners = new Map();
  let compositionAnchor = { x: 3, y: 1 };
  let processKeyAt = null;
  let compositionStarted = 0;
  const compositionView = {
    style: {},
    getBoundingClientRect: () => ({ width: 10 }),
  };
  const textarea = {
    style: {},
    value: "",
    addEventListener(type, listener) {
      textareaListeners.set(type, listener);
    },
    removeEventListener() {},
  };
  const container = {
    scrollTop: 0,
    scrollLeft: 0,
    querySelector(selector) {
      if (selector === ".xterm-helper-textarea") return textarea;
      if (selector === ".composition-view") return compositionView;
      if (selector === ".xterm-viewport") return this;
      return null;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener() {},
  };
  const disposable = { dispose() {} };
  const terminal = {
    cols: 100,
    rows: 4,
    options: { fontSize: 14 },
    buffer: {
      active: {
        cursorX: 99,
        cursorY: 3,
        viewportY: 0,
        getLine() {
          return undefined;
        },
      },
    },
    onCursorMove(callback) {
      terminalListeners.set("cursor", callback);
      return disposable;
    },
    onRender(callback) {
      terminalListeners.set("render", callback);
      return disposable;
    },
    onResize: () => disposable,
  };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.window = globalThis;
  globalThis.document = { activeElement: textarea };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  try {
    const detach = attachTerminalIme({
      terminal,
      container,
      isActiveRef: { current: true },
      isComposingRef: { current: false },
      osPlatformRef: { current: "windows" },
      fontSize: 14,
      getTerminalRenderedCellSize: () => ({ width: 10, height: 20 }),
      forwardNativeInput() {},
      onImeProcessKey: (at) => {
        processKeyAt = at;
      },
      onCompositionStarted: () => {
        compositionStarted += 1;
      },
      clearSuggestion() {},
      updateSuggestionPosition() {},
      scheduleFit() {},
      onCompositionCommitted() {},
      resolveCompositionAnchor: () => compositionAnchor,
      resolveTextareaAnchor: (_terminal, anchor) => ({ ...anchor, y: 2 }),
      shouldRefreshCompositionAnchor: () => true,
    });

    textarea.style.left = "990px";
    textarea.style.top = "60px";
    listeners.get("keydown")({
      target: textarea,
      keyCode: 229,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });

    assert.equal(textarea.style.left, "30px");
    assert.equal(textarea.style.top, "40px");
    assert.equal(typeof processKeyAt, "number");
    assert.equal(textareaListeners.has("compositionstart"), true);

    compositionAnchor = { x: 99, y: 1 };
    textareaListeners.get("compositionstart")();
    assert.equal(compositionStarted, 1);
    assert.equal(compositionView.style.left, "990px");
    assert.equal(compositionView.style.maxWidth, "10px");

    compositionAnchor = { x: 3, y: 1 };
    terminalListeners.get("render")();
    assert.equal(compositionView.style.left, "30px");
    assert.equal(compositionView.style.maxWidth, "970px");
    detach();
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});
