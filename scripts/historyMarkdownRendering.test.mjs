import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-history-markdown-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/lib/markdownSource.ts", import.meta.url),
  "utf8",
);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const outputPath = join(tempDir, "markdownSource.mjs");
writeFileSync(outputPath, output, "utf8");

const { unwrapFencedMarkdown } = await import(pathToFileURL(outputPath).href);

const table = [
  "| 字段 | 类型 |",
  "| --- | --- |",
  "| `count` | `BigDecimal` |",
].join("\n");

test("unwraps a complete markdown source fence for history rendering", () => {
  assert.equal(unwrapFencedMarkdown("````markdown\n" + table + "\n````"), table);
  assert.equal(unwrapFencedMarkdown("~~~MD\n" + table + "\n~~~"), table);
  assert.equal(
    unwrapFencedMarkdown("  ``` markdown  \r\n" + table.replaceAll("\n", "\r\n") + "\r\n```  "),
    table,
  );
});

test("keeps non-source and incomplete fences unchanged", () => {
  const cases = [
    "```js\nconst value = 1;\n```",
    "``markdown\n| A | B |\n| --- | --- |\n```",
    "```markdown\n| A | B |\n| --- | --- |",
    "```markdown\n| A | B |\n| --- | --- |\n~~~",
    "intro\n```markdown\n| A | B |\n| --- | --- |\n```",
    "```markdown extra\n| A | B |\n| --- | --- |\n```",
  ];

  for (const value of cases) assert.equal(unwrapFencedMarkdown(value), value);
});

test("unwraps the outer fence while preserving an inner code fence", () => {
  const nested = "```js\nconst value = 1;\n```";
  const sourceMessage = `~~~~markdown\n${nested}\n~~~~`;
  assert.equal(unwrapFencedMarkdown(sourceMessage), nested);
});

test("history-only integration uses the shared helper and theme variables", () => {
  const historySource = readFileSync(
    new URL("../src/components/history/HistoryMarkdownContent.tsx", import.meta.url),
    "utf8",
  );
  const previewSource = readFileSync(
    new URL("../src/components/terminal/TerminalMarkdownPreview.tsx", import.meta.url),
    "utf8",
  );
  const stylesSource = readFileSync(
    new URL("../src/styles/components.css", import.meta.url),
    "utf8",
  );

  assert.match(historySource, /import \{ unwrapFencedMarkdown \} from "\.\.\/\.\.\/lib\/markdownSource"/);
  assert.match(historySource, /variant === "history"[\s\S]*unwrapFencedMarkdown\(props\.content\)/);
  assert.match(previewSource, /import \{ unwrapFencedMarkdown \} from "\.\.\/\.\.\/lib\/markdownSource"/);
  assert.match(stylesSource, /\.ui-markdown-code-block \{[\s\S]*background-color: var\(--md-canvas-subtle\);/);
  assert.match(stylesSource, /\.ui-markdown-code-header \{[\s\S]*border-bottom: 1px solid var\(--md-border\);[\s\S]*background-color: var\(--md-canvas-muted\);[\s\S]*color: var\(--md-subtle\);/);
  assert.match(stylesSource, /\.ui-markdown-terminal \.ui-markdown-code-block \{[\s\S]*background-color: #0a0a0a;/);
  assert.match(stylesSource, /\.ui-markdown-terminal \.ui-markdown-code-header \{[\s\S]*background-color: #181818;/);
});
