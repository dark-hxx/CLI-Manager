import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/markdownNavigation.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const navigation = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
const markdownRendererSource = readFileSync(
  new URL("../src/components/ui/MarkdownContent.tsx", import.meta.url),
  "utf8",
);
const fileEditorSource = readFileSync(
  new URL("../src/components/files/FileEditorPane.tsx", import.meta.url),
  "utf8",
);
const fileEditorContentSource = readFileSync(
  new URL("../src/components/files/FileEditorContent.tsx", import.meta.url),
  "utf8",
);
const repositoryReadme = readFileSync(new URL("../README.zh-CN.md", import.meta.url), "utf8");

test("Markdown destinations retain external URLs and resolve project-bound paths", () => {
  assert.deepEqual(
    navigation.resolveMarkdownHref("https://example.com/a?q=1#标题", "docs/current.md"),
    { kind: "external", href: "https://example.com/a?q=1#标题" },
  );
  assert.deepEqual(
    navigation.resolveMarkdownHref("../指南/开始%20使用.md#%E4%BA%A4%E6%B5%81", "docs/nested/current.md"),
    { kind: "file", path: "docs/指南/开始 使用.md", fragment: "交流" },
  );
  assert.deepEqual(
    navigation.resolveMarkdownHref("/README.md", "docs/current.md"),
    { kind: "file", path: "README.md", fragment: "" },
  );
});

test("Markdown destinations reject traversal, unsafe schemes, and malformed escapes", () => {
  assert.deepEqual(navigation.resolveMarkdownHref("../../outside.md", "docs/current.md"), {
    kind: "invalid",
    reason: "outside-project",
  });
  assert.deepEqual(navigation.resolveMarkdownHref("javascript:alert(1)", "docs/current.md"), {
    kind: "invalid",
    reason: "unsupported-scheme",
  });
  assert.deepEqual(navigation.resolveMarkdownHref("bad%ZZ.md", "docs/current.md"), {
    kind: "invalid",
    reason: "malformed",
  });
});

test("heading IDs match repository-style Chinese and duplicate anchors", () => {
  const headings = navigation.collectMarkdownHeadings([
    "# 💬 交流讨论",
    "## **重复** 标题",
    "## 重复 标题",
    "```md",
    "# 代码块不是标题",
    "```",
    "Setext 标题",
    "---",
  ].join("\n"));
  assert.deepEqual(headings, [
    { id: "-交流讨论", lineNumber: 1 },
    { id: "重复-标题", lineNumber: 2 },
    { id: "重复-标题-1", lineNumber: 3 },
    { id: "setext-标题", lineNumber: 7 },
  ]);
  assert.equal(navigation.findMarkdownHeadingLine("# 💬 交流讨论", "-交流讨论"), 1);
});

test("README Chinese preview link resolves to its real heading", () => {
  const sourceLine = repositoryReadme.split(/\r?\n/u)[17];
  const clickedColumn = sourceLine.indexOf("[界面预览]") + 2;
  assert.equal(navigation.findMarkdownLinkAtPosition(repositoryReadme, 18, clickedColumn), "#-界面预览");
  assert.equal(navigation.findMarkdownHeadingLine(repositoryReadme, "-界面预览"), 453);
});

test("source navigation recognizes inline, reference, image, autolink, and bare URL links", () => {
  const content = [
    "[inline](./one.md)",
    "[reference][doc]",
    "[doc]",
    "[![image](image.png)](target.md)",
    "<https://example.com/docs>",
    "https://example.com/bare",
    "[doc]: ./two.md",
  ].join("\n");
  assert.equal(navigation.findMarkdownLinkAtPosition(content, 1, 4), "./one.md");
  assert.equal(navigation.findMarkdownLinkAtPosition(content, 2, 5), "./two.md");
  assert.equal(navigation.findMarkdownLinkAtPosition(content, 3, 3), "./two.md");
  assert.equal(navigation.findMarkdownLinkAtPosition(content, 4, 4), "target.md");
  assert.equal(navigation.findMarkdownLinkAtPosition(content, 5, 8), "https://example.com/docs");
  assert.equal(navigation.findMarkdownLinkAtPosition(content, 6, 8), "https://example.com/bare");
});

test("source navigation ignores links inside inline and fenced code", () => {
  const content = [
    "`[inline](ignored.md)`",
    "```md",
    "[fenced](ignored.md)",
    "````",
    "~~~md",
    "[unclosed](ignored.md)",
  ].join("\n");
  assert.equal(navigation.findMarkdownLinkAtPosition(content, 1, 4), null);
  assert.equal(navigation.findMarkdownLinkAtPosition(content, 3, 4), null);
  assert.equal(navigation.findMarkdownLinkAtPosition(content, 6, 4), null);
});

test("renderer scopes anchor navigation and file editor owns source activation", () => {
  assert.match(markdownRendererSource, /anchor\.getAttribute\("href"\)/);
  assert.match(markdownRendererSource, /root\.querySelectorAll<HTMLElement>\("\[id\]"\)/);
  assert.match(markdownRendererSource, /onContextMenu=\{\(event\) => \{/);
  assert.match(fileEditorSource, /editor\.onMouseDown/);
  assert.match(fileEditorSource, /event\.event\.ctrlKey/);
  assert.match(fileEditorSource, /event\.event\.rightButton/);
  assert.match(fileEditorSource, /resolveMarkdownHref\(href, visibleFile\.path\)/);
  assert.match(fileEditorSource, /pendingMarkdownNavigation\.path === visibleFile\?\.path/);
  assert.match(fileEditorContentSource, /collectMarkdownHeadings\(file\.content\)/);
  assert.match(fileEditorContentSource, /querySelectorAll<HTMLElement>\("h1, h2, h3, h4, h5, h6"\)/);
});
