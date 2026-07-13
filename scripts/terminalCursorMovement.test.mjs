import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/terminalCursorMovement.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { buildFastCursorMoveSequence } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

test("long-distance cursor moves use line anchors", () => {
  assert.equal(buildFastCursorMoveSequence(20, 0, 20, true, false), "\x1b[H");
  assert.equal(buildFastCursorMoveSequence(0, 20, 20, true, false), "\x1b[F");
  assert.equal(
    buildFastCursorMoveSequence(20, 3, 20, true, false),
    "\x1b[H\x1b[C\x1b[C\x1b[C"
  );
  assert.equal(
    buildFastCursorMoveSequence(0, 17, 20, true, false),
    "\x1b[F\x1b[D\x1b[D\x1b[D"
  );
});

test("nearby and multiline cursor moves keep direct arrows", () => {
  assert.equal(buildFastCursorMoveSequence(10, 8, 20, true, false), "\x1b[D\x1b[D");
  assert.equal(
    buildFastCursorMoveSequence(20, 0, 20, false, false),
    "\x1b[D".repeat(20)
  );
});

test("application cursor mode uses xterm application sequences", () => {
  assert.equal(buildFastCursorMoveSequence(20, 0, 20, true, true), "\x1bOH");
  assert.equal(buildFastCursorMoveSequence(0, 20, 20, true, true), "\x1bOF");
});
