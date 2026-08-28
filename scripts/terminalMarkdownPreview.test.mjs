import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const previewSource = readFileSync(
  new URL("../src/components/terminal/TerminalMarkdownPreview.tsx", import.meta.url),
  "utf8",
);
const historyStoreSource = readFileSync(
  new URL("../src/stores/historyStore.ts", import.meta.url),
  "utf8",
);
const terminalSource = readFileSync(
  new URL("../src/components/XTermTerminal.tsx", import.meta.url),
  "utf8",
);
const terminalTabsSource = readFileSync(
  new URL("../src/components/TerminalTabs.tsx", import.meta.url),
  "utf8",
);
const i18nSource = readFileSync(
  new URL("../src/lib/i18n.ts", import.meta.url),
  "utf8",
);

test("markdown preview waits for the bound session catalog refresh", () => {
  assert.match(previewSource, /const waitForCatalogRefresh = attempt === 0/);
  assert.match(previewSource, /waitForCatalogRefresh\s*\}/);
  assert.match(historyStoreSource, /wait:\s*waitForCatalogRefresh/);
});

test("failed markdown preview loads are retryable and background terminal layout stays intact", () => {
  const successBlock = previewSource.match(
    /if \(detail\) \{([\s\S]*?)setPreviewMessages\(nextMessages\);/,
  );
  assert.ok(successBlock, "expected the successful detail branch");
  assert.match(successBlock[1], /loadedTriggerRef\.current\s*=\s*trigger/);

  const effectBlock = previewSource.match(
    /if \(loadedTriggerRef\.current === previewLoadTrigger\) return;([\s\S]*?)\n  \}, \[hookStatus,/,
  );
  assert.ok(effectBlock, "expected the preview load effect");
  assert.doesNotMatch(effectBlock[1], /loadedTriggerRef\.current\s*=\s*previewLoadTrigger/);

  assert.match(terminalSource, /data-bg-enabled/);
  assert.match(terminalSource, /ref=\{containerRef\}/);
});

test("markdown preview can select every assistant response and unwrap source fences", () => {
  assert.match(previewSource, /function selectAssistantMarkdownMessages/);
  assert.match(previewSource, /message\?\.role\.toLowerCase\(\) !== "assistant"/);
  assert.match(previewSource, /function unwrapFencedMarkdown/);
  assert.match(previewSource, /MARKDOWN_SOURCE_FENCE/);
  assert.match(previewSource, /unwrapFencedMarkdown\(selectedMessage\.content\)/);
  assert.match(previewSource, /terminal-markdown-preview-message-select/);
  assert.match(previewSource, /terminal\.markdownPreview\.answerOption/);
  assert.match(i18nSource, /terminal\.markdownPreview\.selectAnswer/);
});

test("markdown preview supports themed answer scrolling, wheel zoom, and restored sessions", () => {
  assert.match(previewSource, /@radix-ui\/react-select/);
  assert.match(previewSource, /ui-thin-scroll max-h-\[220px\]/);
  assert.match(previewSource, /event\.ctrlKey \&\& !event\.metaKey|!event\.ctrlKey \|\| !event\.metaKey/);
  assert.match(previewSource, /MARKDOWN_PREVIEW_FONT_SIZE_MIN/);
  assert.match(previewSource, /onWheel=\{handlePreviewWheel\}/);
  assert.match(previewSource, /<FontSizeControl/);
  assert.match(terminalSource, /const markdownPreviewCanOpen = markdownPreviewSupported\s*&&\s*Boolean\(terminalSession\?\.cliSessionId\?\.trim\(\)\);/);
  assert.doesNotMatch(terminalSource, /markdownPreviewHookStatus/);
});

test("configured CLI terminals keep a preview control and recognize every history source", () => {
  assert.doesNotMatch(previewSource, /PREVIEW_SOURCES/);
  assert.match(previewSource, /value\): value is HistorySource => value !== null/);
  assert.match(terminalSource, /const markdownPreviewButtonVisible = Boolean\(/);
  assert.match(terminalSource, /terminalSession\?\.isAgentSession/);
  assert.match(terminalSource, /\{markdownPreviewButtonVisible && \(/);
});

test("middle mouse closes session and Workspan tabs through the existing close flow", () => {
  const middleClickHandlers = terminalTabsSource.split("onAuxClick={(event) => {").slice(1);
  assert.equal(middleClickHandlers.length, 2);
  for (const handler of middleClickHandlers) {
    assert.match(handler, /event\.button !== 1/);
    assert.match(handler, /event\.preventDefault\(\)/);
    assert.match(handler, /onClose\(event\.currentTarget\.getBoundingClientRect\(\)\)/);
  }
});
