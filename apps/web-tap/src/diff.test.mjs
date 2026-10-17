import assert from "node:assert/strict";
import { test } from "node:test";
import { hunkRows } from "./diff.ts";

test("改動的每一行標出行號：刪除的行用舊檔的行號，新增與未變的用新檔的", () => {
  const rows = hunkRows({ oldStart: 10, oldLines: 3, newStart: 12, newLines: 3, lines: [" keep", "-old", "+new", "+more", " tail"] });
  assert.deepEqual(rows, [
    { tone: "same", number: 12, text: "keep" },
    { tone: "del", number: 11, text: "old" },
    { tone: "add", number: 13, text: "new" },
    { tone: "add", number: 14, text: "more" },
    { tone: "same", number: 15, text: "tail" },
  ]);
});

test("空行與只有刪除的區塊", () => {
  assert.deepEqual(hunkRows({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ["-a", "-"] }), [
    { tone: "del", number: 1, text: "a" },
    { tone: "del", number: 2, text: "" },
  ]);
  assert.deepEqual(hunkRows({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [] }), []);
});
