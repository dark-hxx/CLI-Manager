import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/terminalFileLinks.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  findTerminalFileLinks,
  findTerminalRelativeFileLinks,
  terminalStringRangeToBufferColumns,
} = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);

test("relative file links do not capture HTTP URLs", () => {
  assert.deepEqual(findTerminalRelativeFileLinks("https://example.com/docs/file.ts"), []);
  assert.deepEqual(
    findTerminalRelativeFileLinks("https://example.com/docs src/lib/file.ts").map((match) => match.path),
    ["src/lib/file.ts"],
  );
});

test("absolute file links preserve line locations with diagnostic suffixes", () => {
  const [match] = findTerminalFileLinks(String.raw`D:\repo\src\main.ts:12:3:error`);
  assert.equal(match.path, String.raw`D:\repo\src\main.ts`);
  assert.equal(match.lineNumber, 12);
  assert.equal(match.columnNumber, 3);
});

test("relative file links strip trailing source symbols", () => {
  const [match] = findTerminalRelativeFileLinks("src/components/TerminalTabs.tsx:handleToggleFilesPanel");
  assert.equal(match.text, "src/components/TerminalTabs.tsx:handleToggleFilesPanel");
  assert.equal(match.path, "src/components/TerminalTabs.tsx");
});

test("relative file links split Chinese enumeration separators", () => {
  const matches = findTerminalRelativeFileLinks(
    "src/components/files/FileExplorerSidebar.tsx:438、src/components/files/FileExplorerSidebar.tsx:1047",
  );
  assert.deepEqual(
    matches.map(({ path, lineNumber }) => ({ path, lineNumber })),
    [
      { path: "src/components/files/FileExplorerSidebar.tsx", lineNumber: 438 },
      { path: "src/components/files/FileExplorerSidebar.tsx", lineNumber: 1047 },
    ],
  );
});

test("string ranges map to xterm columns across wide cells", () => {
  const cells = [
    { chars: "根", width: 2 },
    { chars: "", width: 0 },
    { chars: "因", width: 2 },
    { chars: "", width: 0 },
    { chars: " ", width: 1 },
    ...Array.from("src/lib/file.ts", (chars) => ({ chars, width: 1 })),
  ];
  const line = {
    length: cells.length,
    getCell(index) {
      const cell = cells[index];
      return cell && {
        getChars: () => cell.chars,
        getWidth: () => cell.width,
      };
    },
  };

  assert.deepEqual(terminalStringRangeToBufferColumns(line, 3, 18), {
    startColumn: 5,
    endColumn: 20,
  });
});
