import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/components/XTermTerminal.tsx", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const settingsSource = readFileSync(
  new URL("../src/stores/settingsStore.ts", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

test("bottom shortcut only appears above the live bottom of a normal buffer", () => {
  const updater = source.match(
    /const updateScrollToBottomButton = \(\) => \{([\s\S]*?)\n    \};/,
  )?.[1];

  assert.ok(updater, "the scroll state updater was not found");
  assert.match(updater, /buffer\.type === "normal"/);
  assert.match(updater, /buffer\.viewportY < buffer\.baseY/);
  assert.match(source, /\{isScrolledAwayFromBottom && \([\s\S]*?terminal-scroll-to-bottom/);
});

test("scroll position changes update the shortcut and click uses xterm's public API", () => {
  assert.match(source, /terminal\.onScroll\(\(\) => \{[\s\S]*?updateScrollToBottomButton\(\);/);
  assert.match(source, /terminal\.onWriteParsed\(updateScrollToBottomButton\)/);
  assert.match(source, /terminal\.onResize\(updateScrollToBottomButton\)/);

  const handler = source.match(
    /const handleScrollToBottom = \(\) => \{([\s\S]*?)\n  \};/,
  )?.[1];
  assert.ok(handler, "the scroll-to-bottom handler was not found");
  assert.match(handler, /terminal\.scrollToBottom\(\)/);
  assert.match(handler, /setIsScrolledAwayFromBottom\(false\)/);
  assert.doesNotMatch(handler, /terminalProcessManager\.write/);
});

test("terminal scroll shortcuts page normal buffers without hijacking alternate-screen apps", () => {
  assert.match(settingsSource, /scrollToBottom: "Ctrl\+End"/);
  assert.match(settingsSource, /pageUp: "PageUp"/);
  assert.match(settingsSource, /pageDown: "PageDown"/);

  const shortcutHandler = source.match(
    /if \(e\.type === "keydown" && terminal\.buffer\.active\.type === "normal"\) \{([\s\S]*?)\n      \}/,
  )?.[1];
  assert.ok(shortcutHandler, "the normal-buffer shortcut handler was not found");
  assert.match(shortcutHandler, /scrollShortcuts\.scrollToBottom/);
  assert.match(shortcutHandler, /terminal\.scrollPages\(-1\)/);
  assert.match(shortcutHandler, /terminal\.scrollPages\(1\)/);
});
