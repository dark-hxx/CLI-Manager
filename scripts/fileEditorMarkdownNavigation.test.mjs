import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(file, dependencies = {}) {
  const text = readFileSync(new URL(file, import.meta.url), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText()).join("\n");
  const output = ts.transpileModule(body, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(output, { exports, ...dependencies });
  return exports;
}
const navigation = load("../src/shared/lib/markdownNavigation.ts");
const file = (path = "docs/current.md") => ({ path, content: "# Heading", previewKind: "markdown" });
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const errors = [], urls = [], reveals = [], editorCalls = [];
  let effects = [], activeFile = file();
  const options = {
    t: key => key,
    visibleFile: activeFile,
    revealPath: path => new Promise((resolve, reject) => reveals.push({ path, resolve, reject })),
    editorRef: { current: {
      setPosition: value => editorCalls.push(["position", value.lineNumber]),
      revealLineInCenter: value => editorCalls.push(["reveal", value]),
      focus: () => editorCalls.push(["focus"]),
    } },
    markdownNavigationRef: { current: null },
    markdownNavigationIdRef: { current: 0 },
    nextMarkdownModeRef: { current: null },
    pendingMarkdownNavigation: null,
    setPendingMarkdownNavigation: value => {
      options.pendingMarkdownNavigation = typeof value === "function" ? value(options.pendingMarkdownNavigation) : value;
    },
    previewMode: "source",
    setPreviewMode: value => { options.previewMode = value; },
    editorReadyNonce: 0,
  };
  const { useFileEditorMarkdownNavigation } = load("../src/features/files/hooks/useFileEditorMarkdownNavigation.ts", {
    ...navigation,
    useCallback: callback => callback,
    useEffect: callback => effects.push(callback),
    toast: { error: value => errors.push(value) },
    openUrl: async url => { urls.push(url); },
    useFileExplorerStore: { getState: () => ({ activeFile }) },
  });
  return {
    options, errors, urls, reveals, editorCalls,
    setActiveFile: value => { activeFile = value; },
    render() { effects = []; return useFileEditorMarkdownNavigation({ ...options }); },
    flushEffects() { for (const effect of effects) effect(); },
  };
}

test("editor navigation uses the opener only for external URLs and rejects project escape", async () => {
  const f = fixture(), actions = f.render();
  actions.handleMarkdownLinkActivate("https://example.com/a?q=1#heading", "preview");
  actions.handleMarkdownLinkActivate("../../../outside.md", "source");
  await settle();
  assert.deepEqual(f.urls, ["https://example.com/a?q=1#heading"]);
  assert.deepEqual(f.errors, ["files.toast.markdownLinkOutsideProject"]);
  assert.equal(f.reveals.length, 0);
});

test("source headings reveal in Monaco while preview headings retain request identity", () => {
  const f = fixture(), actions = f.render();
  assert.equal(f.options.markdownNavigationRef.current, actions.handleMarkdownLinkActivate);
  actions.handleMarkdownLinkActivate("#heading", "source");
  assert.deepEqual(f.editorCalls, [["position", 1], ["reveal", 1], ["focus"]]);
  actions.handleMarkdownLinkActivate("#heading", "preview");
  assert.equal(f.options.pendingMarkdownNavigation.id, 1);
  assert.equal(f.options.pendingMarkdownNavigation.mode, "preview");
  actions.handleMarkdownFragmentHandled(2, true);
  assert.equal(f.options.pendingMarkdownNavigation.id, 1, "a different fragment completion cannot clear the request");
  actions.handleMarkdownFragmentHandled(1, true);
  assert.equal(f.options.pendingMarkdownNavigation, null);
});

test("late navigation failures cannot clear a newer request", async () => {
  const f = fixture(), actions = f.render();
  actions.handleMarkdownLinkActivate("one.md#heading", "preview");
  actions.handleMarkdownLinkActivate("two.md#heading", "preview");
  f.reveals[0].reject(new Error("old failure"));
  await settle();
  assert.equal(f.options.pendingMarkdownNavigation.path, "docs/two.md");
  assert.equal(f.errors.length, 0);
  f.setActiveFile(file("docs/two.md"));
  f.reveals[1].resolve(true);
  await settle();
  assert.equal(f.options.pendingMarkdownNavigation.id, 2);
});

test("missing targets clear pending mode and report a localized error", async () => {
  const f = fixture();
  f.render().handleMarkdownLinkActivate("missing.md", "preview");
  f.reveals[0].resolve(false);
  await settle();
  assert.equal(f.options.pendingMarkdownNavigation, null);
  assert.equal(f.options.nextMarkdownModeRef.current, null);
  assert.deepEqual(f.errors, ["files.toast.markdownLinkMissing"]);
});

test("matching source navigation changes mode before revealing the fragment", () => {
  const f = fixture();
  f.options.previewMode = "preview";
  f.options.pendingMarkdownNavigation = { id: 1, path: "docs/current.md", fragment: "heading", mode: "source" };
  f.render(); f.flushEffects();
  assert.equal(f.options.previewMode, "source");
  assert.equal(f.editorCalls.length, 0);
  f.render(); f.flushEffects();
  assert.deepEqual(f.editorCalls, [["position", 1], ["reveal", 1], ["focus"]]);
  assert.equal(f.options.pendingMarkdownNavigation, null);
});
