import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const componentSource = readFileSync(
  new URL("../src/components/XTermTerminal.tsx", import.meta.url),
  "utf8",
);
const stylesSource = readFileSync(
  new URL("../src/styles/components.css", import.meta.url),
  "utf8",
);

test("terminal content remains a full-size positioned layer", () => {
  assert.match(
    componentSource,
    /<div className="absolute inset-0 overflow-hidden">\s*<div[\s\S]*?ref=\{containerRef\}/,
  );
});

test("background stacking does not override terminal child positioning", () => {
  const stackingRule = stylesSource.match(
    /\.ui-terminal-bg-layer\[data-bg-enabled="true"\]\s*>\s*\*\s*\{([^}]*)\}/,
  );

  assert.ok(stackingRule, "expected the terminal background stacking rule");
  assert.match(stackingRule[1], /z-index:\s*2\s*;/);
  assert.doesNotMatch(stackingRule[1], /\bposition\s*:/);
});

test("background mode keeps terminal controls above the content layer", () => {
  assert.match(componentSource, /terminal-markdown-preview-toggle/);
  assert.match(componentSource, /terminal-search-shell/);
  assert.match(
    stylesSource,
    /\.ui-terminal-bg-layer\[data-bg-enabled="true"\]\s*>\s*\.terminal-markdown-preview-toggle,[\s\S]*?z-index:\s*20\s*;/,
  );
});

test("markdown preview exposes the shared terminal background image", () => {
  assert.match(
    stylesSource,
    /\.ui-terminal-bg-layer\[data-bg-enabled="true"\]\s+\.terminal-markdown-preview\s*\{[\s\S]*?background:\s*[\s\S]*?color-mix\(/,
  );
});
