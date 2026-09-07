import assert from "node:assert/strict";
import test from "node:test";
import { baselineFor, checkMetrics, dependencyViolations, imports, isSource, measure } from "./architecture/core.mjs";

test("physical line boundaries include blanks but not a phantom final newline", () => {
  assert.equal(measure("a.ts", "").lines, 0);
  assert.equal(measure("a.ts", "a\r\n\r\n").lines, 2);
  assert.deepEqual(checkMetrics([measure("a.ts", "x\n".repeat(2000))]), []);
  assert.equal(checkMetrics([measure("a.ts", "x\n".repeat(2001))]).length, 1);
});

test("baseline permits existing debt but no growth or renamed oversized file", () => {
  const old = measure("old.rs", "x\n".repeat(2100));
  const baseline = baselineFor([old]);
  assert.deepEqual(checkMetrics([measure("old.rs", "x\n".repeat(2099))], baseline), []);
  assert.equal(checkMetrics([measure("old.rs", "x\n".repeat(2101))], baseline).length, 1);
  assert.equal(checkMetrics([{ ...old, file: "new.rs" }], baseline).length, 1);
});

test("compressed logic cannot be added or duplicated under the baseline", () => {
  const old = measure("a.ts", "x".repeat(501));
  assert.deepEqual(checkMetrics([old], baselineFor([old])), []);
  assert.equal(checkMetrics([measure("a.ts", "y".repeat(501))], baselineFor([old])).length, 1);
  assert.equal(checkMetrics([measure("a.ts", ("x".repeat(501) + "\n").repeat(2))], baselineFor([old])).length, 1);
});

test("application sources are scanned but explicit generated scaffolding is not", () => {
  assert.equal(isSource("src/features/git/tests/fixture.ts"), true);
  assert.equal(isSource("src-tauri/ssh-agent/src/lib.rs"), true);
  assert.equal(isSource("scripts/check.mts"), true);
  assert.equal(isSource(".github/scripts/release.mjs"), true);
  assert.equal(isSource("src-tauri/gen/schemas/test.ts"), false);
  assert.equal(isSource("package-lock.json"), false);
});

test("import parsing includes type imports, exports and dynamic imports, not comments", () => {
  const source = 'import type { X } from "../x"; export { y } from "../y"; import("../z"); // import("../fake")';
  assert.deepEqual(imports("src/a.ts", source), ["../x", "../y", "../z"]);
});

test("layer rules allow composition and public cross-feature access only", () => {
  assert.equal(dependencyViolations("src/shared/lib/a.ts", ["../../features/git"]).length, 1);
  assert.equal(dependencyViolations("src/features/git/a.ts", ["../../app/main"]).length, 1);
  assert.equal(dependencyViolations("src/features/git/a.ts", ["../files/lib/private"]).length, 1);
  assert.deepEqual(dependencyViolations("src/features/git/a.ts", ["../files", "../../shared/lib/path"]), []);
  assert.equal(dependencyViolations("src-tauri/src/shared/a.rs", ["crate::features::git::run"]).length, 1);
  assert.deepEqual(dependencyViolations("src-tauri/src/features/files/a.rs", ["crate::features::git::run"]), []);
  assert.equal(dependencyViolations("src-tauri/src/features/files/a.rs", ["crate::features::git::internal::run"]).length, 1);
});
