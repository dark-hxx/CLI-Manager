import assert from "node:assert/strict";
import test from "node:test";
import { baselineFor, checkMetrics, dependencyViolations, imports, isSource, measure } from "./architecture/core.mjs";

// 验证物理行计数及 2000 行边界，不把末尾换行计作额外空行。
test("physical line boundaries include blanks but not a phantom final newline", () => {
  assert.equal(measure("a.ts", "").lines, 0);
  assert.equal(measure("a.ts", "a\r\n\r\n").lines, 2);
  assert.deepEqual(checkMetrics([measure("a.ts", "x\n".repeat(2000))]), []);
  assert.equal(checkMetrics([measure("a.ts", "x\n".repeat(2001))]).length, 1);
});

// 验证基线仅允许原有超限文件缩减，不允许增长或改名继承豁免。
test("baseline permits existing debt but no growth or renamed oversized file", () => {
  const old = measure("old.rs", "x\n".repeat(2100));
  const baseline = baselineFor([old]);
  assert.deepEqual(checkMetrics([measure("old.rs", "x\n".repeat(2099))], baseline), []);
  assert.equal(checkMetrics([measure("old.rs", "x\n".repeat(2101))], baseline).length, 1);
  assert.equal(checkMetrics([{ ...old, file: "new.rs" }], baseline).length, 1);
});

// 验证基线不能掩盖新增或重复的压缩长行。
test("compressed logic cannot be added or duplicated under the baseline", () => {
  const old = measure("a.ts", "x".repeat(501));
  assert.deepEqual(checkMetrics([old], baselineFor([old])), []);
  assert.equal(checkMetrics([measure("a.ts", "y".repeat(501))], baselineFor([old])).length, 1);
  assert.equal(checkMetrics([measure("a.ts", ("x".repeat(501) + "\n").repeat(2))], baselineFor([old])).length, 1);
});

// 验证扫描业务源码并仅排除明确生成的脚手架文件。
test("application sources are scanned but explicit generated scaffolding is not", () => {
  assert.equal(isSource("src/features/git/tests/fixture.ts"), true);
  assert.equal(isSource("src-tauri/ssh-agent/src/lib.rs"), true);
  assert.equal(isSource("scripts/check.mts"), true);
  assert.equal(isSource(".github/scripts/release.mjs"), true);
  assert.equal(isSource("src-tauri/gen/schemas/test.ts"), false);
  assert.equal(isSource("package-lock.json"), false);
});

// 验证导入分析包含类型、导出与动态导入，但忽略注释。
test("import parsing includes type imports, exports and dynamic imports, not comments", () => {
  const source = 'import type { X } from "../x"; export { y } from "../y"; import("../z"); // import("../fake")';
  assert.deepEqual(imports("src/a.ts", source), ["../x", "../y", "../z"]);
});

// 验证内联类型导入也纳入依赖边界检查。
test("inline import types also obey dependency boundaries", () => {
  assert.deepEqual(imports("src/a.ts", 'type X = import("../feature").X;'), ["../feature"]);
});

// 验证跨功能仅允许窄公共入口，拒绝内部路径及旧目录。
test("feature API modules are narrow entries, not permission for internal subdirectories", () => {
  const from = "src/features/git/components/View.tsx";
  assert.deepEqual(dependencyViolations(from, ["../../terminal/state", "../../files/api/FileExplorerSidebar"]), []);
  assert.equal(dependencyViolations(from, ["../../files/api/internal/private"]).length, 1);
  assert.equal(dependencyViolations(from, ["../../files/store/fileExplorerStore"]).length, 1);
  assert.equal(dependencyViolations(from, ["../../../stores/fileExplorerStore"]).length, 1);
  assert.equal(dependencyViolations("src/shared/ui/View.tsx", ["../../lib/i18n"]).length, 1);
});

// 验证前后端分层依赖只允许应用组合及公共跨功能访问。
test("layer rules allow composition and public cross-feature access only", () => {
  assert.equal(dependencyViolations("src/shared/lib/a.ts", ["../../features/git"]).length, 1);
  assert.equal(dependencyViolations("src/features/git/a.ts", ["../../app/main"]).length, 1);
  assert.equal(dependencyViolations("src/features/git/a.ts", ["../files/lib/private"]).length, 1);
  assert.deepEqual(dependencyViolations("src/features/git/a.ts", ["../files", "../../shared/lib/path"]), []);
  assert.equal(dependencyViolations("src-tauri/src/shared/a.rs", ["crate::features::git::run"]).length, 1);
  assert.deepEqual(dependencyViolations("src-tauri/src/features/files/a.rs", ["crate::features::git::run"]), []);
  assert.equal(dependencyViolations("src-tauri/src/features/files/a.rs", ["crate::features::git::internal::run"]).length, 1);
});
