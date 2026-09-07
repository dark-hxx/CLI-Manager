import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { readFileSync as readComposedSource } from "./helpers/readComposedSource.mjs";

test("locale catalogs expose the same keys in both languages without duplicate definitions", () => {
  const source = readComposedSource(new URL("../src/shared/i18n/index.ts", import.meta.url));
  const parsed = ts.createSourceFile("catalogs.ts", source, ts.ScriptTarget.Latest, true);
  const keys = { zh: [], en: [] };
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(parsed);
      if (!keys[name]) continue;
      const object = ts.isAsExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer;
      if (!ts.isObjectLiteralExpression(object)) continue;
      for (const property of object.properties) {
        if (ts.isPropertyAssignment(property)) keys[name].push(property.name.text);
      }
    }
  }
  assert.ok(keys.zh.length > 4000);
  assert.equal(new Set(keys.zh).size, keys.zh.length);
  assert.equal(new Set(keys.en).size, keys.en.length);
  assert.deepEqual(keys.zh.sort(), keys.en.sort());
});

test("style entry is an explicit ordered manifest with no duplicate imports", () => {
  const entry = readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");
  const imports = [...entry.matchAll(/@import "([^"]+)";/g)].map((match) => match[1]);
  assert.ok(imports.length > 1);
  assert.equal(new Set(imports).size, imports.length);
  assert.equal(entry.replace(/@import "[^"]+";/g, "").trim(), "");
  const expanded = readComposedSource(new URL("../src/styles/components.css", import.meta.url));
  assert.match(expanded, /@font-face/);
  assert.match(expanded, /\.ui-terminal-bg-layer/);
});
