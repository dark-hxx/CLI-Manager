import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appStyles = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

test("xterm DOM character measurement fallback remains measurable and hidden", () => {
  const rule = appStyles.match(/\.xterm \.xterm-char-measure-element\s*\{([^}]*)\}/)?.[1];

  assert.ok(rule, "expected a scoped xterm character measurement fallback rule");
  assert.match(rule, /display:\s*inline-block;/);
  assert.match(rule, /visibility:\s*hidden;/);
  assert.match(rule, /position:\s*absolute;/);
  assert.match(rule, /top:\s*0;/);
  assert.match(rule, /left:\s*-9999em;/);
  assert.match(rule, /line-height:\s*normal;/);
  assert.doesNotMatch(rule, /display:\s*none;/);
});
