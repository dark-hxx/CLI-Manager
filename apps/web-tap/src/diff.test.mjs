import assert from "node:assert/strict";
import { test } from "node:test";
import { countLines, createdHunk, hunkRows, lineDiff, splitLines } from "./diff.ts";
import { parsePatch, shellPatch } from "./patch.ts";

test("Edit：由 old_string／new_string 算出行級差異，刪除排在新增前面，未變的行保留", () => {
  assert.deepEqual(lineDiff("keep\nold\ntail\n", "keep\nnew\nmore\ntail\n"), [" keep", "-old", "+new", "+more", " tail"]);
  assert.deepEqual(lineDiff("a\nb\nc", "a\nc"), [" a", "-b", " c"]);
  assert.deepEqual(lineDiff("", "x\ny"), ["+x", "+y"]);
  assert.deepEqual(lineDiff("x\r\ny", "x\ny"), [" x", " y"], "CRLF does not count as a change");
  assert.deepEqual(lineDiff("same", "same"), [" same"]);
  // 中間交錯的改動找最長共同子序列，不會把整段當成重寫。
  assert.deepEqual(lineDiff("1\n2\n3\n4\n5", "1\nX\n3\n4\nY\n5"), [" 1", "-2", "+X", " 3", " 4", "+Y", " 5"]);
  assert.deepEqual(countLines([{ lines: lineDiff("a\nb", "a\nc\nd") }]), { added: 2, removed: 1 });
});

test("中間太大時改成整段刪除再整段新增，不建立過大的表格", () => {
  const before = Array.from({ length: 1200 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 1200 }, (_, i) => `new ${i}`).join("\n");
  const lines = lineDiff(`head\n${before}\ntail`, `head\n${after}\ntail`);
  assert.equal(lines[0], " head");
  assert.equal(lines.at(-1), " tail");
  assert.deepEqual(countLines([{ lines }]), { added: 1200, removed: 1200 });
  assert.ok(lines.slice(1, 1201).every((line) => line.startsWith("-")));
});

test("Write：整份內容視為新增，從第 1 行起編號", () => {
  const hunk = createdHunk("first\n\nthird\n");
  assert.deepEqual(hunk.lines, ["+first", "+", "+third"]);
  assert.deepEqual(hunkRows(hunk), [
    { tone: "add", number: 1, text: "first" }, { tone: "add", number: 2, text: "" }, { tone: "add", number: 3, text: "third" },
  ]);
  assert.deepEqual(createdHunk("").lines, []);
  assert.deepEqual(splitLines("a\n"), ["a"]);
});

test("行號只在確定時編：已知起點照舊檔、新檔分別往下數，不知道時沒有行號", () => {
  assert.deepEqual(hunkRows({ oldStart: 10, newStart: 12, lines: [" keep", "-old", "+new", " tail"] }), [
    { tone: "same", number: 12, text: "keep" }, { tone: "del", number: 11, text: "old" },
    { tone: "add", number: 13, text: "new" }, { tone: "same", number: 14, text: "tail" },
  ]);
  assert.deepEqual(hunkRows({ lines: [" keep", "-old", "+new"] }), [
    { tone: "same", number: undefined, text: "keep" }, { tone: "del", number: undefined, text: "old" },
    { tone: "add", number: undefined, text: "new" },
  ]);
});

test("apply_patch 依檔案分組：修改、新增、刪除、搬移與 @@ 定位文字", () => {
  const files = parsePatch([
    "*** Begin Patch",
    "*** Update File: src/app.ts",
    "@@ function main()",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "",
    "@@",
    "-old()",
    "+next()",
    "*** End of File",
    "*** Add File: src/new.ts",
    "+export const x = 1;",
    "+",
    "*** Delete File: src/gone.ts",
    "*** Update File: src/a.ts",
    "*** Move to: src/b.ts",
    "@@",
    "-a",
    "+b",
    "*** End Patch",
    "*** Update File: ignored.ts",
  ].join("\n"));
  assert.deepEqual(files.map((file) => [file.op, file.path, file.moved]), [
    ["update", "src/app.ts", undefined], ["add", "src/new.ts", undefined], ["delete", "src/gone.ts", undefined], ["update", "src/a.ts", "src/b.ts"],
  ]);
  assert.deepEqual(files[0].hunks, [
    { header: "function main()", lines: [" const a = 1;", "-const b = 2;", "+const b = 3;"] },
    { lines: ["-old()", "+next()"] },
  ]);
  assert.deepEqual(files[1].hunks, [{ oldStart: 0, newStart: 1, lines: ["+export const x = 1;", "+"] }]);
  assert.deepEqual(files[2].hunks, []);
  assert.deepEqual(countLines(files.flatMap((file) => file.hunks)), { added: 5, removed: 3 });
});

test("被截斷的修補照樣解析讀得到的部分；殼層裡的 apply_patch 取出修補文字", () => {
  const files = parsePatch("*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n+z\n");
  assert.deepEqual(files, [{ path: "a.ts", op: "update", hunks: [{ lines: ["-x", "+y", "+z"] }] }]);
  assert.deepEqual(parsePatch("not a patch"), []);
  assert.equal(shellPatch(["apply_patch", "*** Begin Patch\n*** End Patch"], ""), "*** Begin Patch\n*** End Patch");
  assert.equal(shellPatch(undefined, "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a\n+b\n*** End Patch\nEOF"),
    "*** Begin Patch\n*** Add File: a\n+b\n*** End Patch\nEOF");
  assert.equal(shellPatch(["bash", "-lc", "ls"], "ls"), undefined);
  assert.equal(shellPatch(undefined, "apply_patch_helper --check"), undefined);
});
