import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/lib/terminalIme.ts", import.meta.url),
  "utf8",
);

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
