import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { normalizeFileOperationEntries } from "../src/features/files/lib/fileExplorerOperations.ts";

// Execute the real TSX handlers without launching a browser, Tauri or any service.
const source = readFileSync(new URL("../src/features/files/api/FileExplorerSidebar.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("FileExplorerSidebar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode(predicate) {
  let found;
  function visit(node) { if (predicate(node)) found = node; else ts.forEachChild(node, visit); }
  visit(ast);
  assert.ok(found, "handler not found");
  return found;
}
function callback(name, context) {
  const node = findNode((node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
  return evaluate(node.initializer.arguments[0], context);
}
function evaluate(node, context) {
  const text = `module.exports = (${node.getText(ast)});`;
  const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { ...context, module });
  return module.exports;
}
const entry = (path) => ({ path, name: path, kind: "file" });
const a = entry("a"), b = entry("b");
function keyEvent(key, options = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    target: {}, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
}

test("row Delete and Ctrl+X operate on the selection, not only the focused row", () => {
  const state = { project: { environment_type: "local" }, selectedEntries: [a, b], mutationBusy: false };
  const confirmations = [], clipboard = [];
  const handler = callback("handleFileKeyDown", {
    useFileExplorerStore: { getState: () => state }, isFileActionInput: () => false,
    setConfirmAction: (action) => confirmations.push(action), setClipboard: (value) => clipboard.push(value),
  });
  handler(keyEvent("Delete"), a);
  handler(keyEvent("x", { ctrlKey: true }), b);
  assert.deepEqual([...confirmations[0].entries], [a, b]);
  assert.deepEqual([...clipboard[0].entries], [a, b]);
  assert.equal(clipboard[0].mode, "move");
});

test("row shortcuts ignore text inputs and cannot mutate SSH or busy projects", () => {
  for (const [input, remote, busy] of [[true, false, false], [false, true, false], [false, false, true]]) {
    const handler = callback("handleFileKeyDown", {
      useFileExplorerStore: { getState: () => ({ project: { environment_type: remote ? "ssh" : "local" }, mutationBusy: busy, selectedEntries: [a] }) },
      isFileActionInput: () => input,
      setConfirmAction: () => assert.fail("unexpected delete"), setClipboard: () => assert.fail("unexpected clipboard mutation"),
    });
    for (const event of [keyEvent("Delete"), keyEvent("x", { ctrlKey: true }), keyEvent("v", { ctrlKey: true })]) {
      handler(event, a);
      assert.equal(event.defaultPrevented, false);
    }
  }
});

test("empty selection after Ctrl-deselect does not delete the focused row", () => {
  const handler = callback("handleFileKeyDown", {
    useFileExplorerStore: { getState: () => ({ project: { environment_type: "local" }, selectedEntries: [] }) },
    isFileActionInput: () => false, setConfirmAction: () => assert.fail("empty selection deleted"),
  });
  handler(keyEvent("Delete"), a);
});

test("Ctrl-click toggles without opening; a completed drag does not collapse selection", () => {
  const node = findNode((node) => ts.isJsxAttribute(node) && node.name.getText(ast) === "onClick"
    && node.initializer?.getText(ast).includes("isTerminalFilePointerDragClickHandled") && node.initializer?.getText(ast).includes("toggleDirectory"));
  const selections = [];
  let opens = 0;
  const click = evaluate(node.initializer.expression, {
    selectEntry: (...args) => selections.push(args), displayEntry: a,
    isTerminalFilePointerDragClickHandled: (element) => element.dataset.pointerDragHandled === "true",
    isDir: false, onOpenFile: () => { opens += 1; }, toggleDirectory: () => assert.fail("unexpected toggle"),
  });
  click({ currentTarget: { dataset: {} }, ctrlKey: true, preventDefault() {} });
  assert.equal(opens, 0);
  assert.equal(selections[0][1], true);
  click({ currentTarget: { dataset: { pointerDragHandled: "true" } } });
  assert.equal(selections.length, 1);
  click({ currentTarget: { dataset: {} } });
  assert.equal(opens, 1);
});

test("pointer-down on selected row snapshots every entry without collapsing selection", () => {
  let captured;
  let selects = 0;
  const handler = callback("handleFilePointerDown", {
    project: { id: "one", path: "E:\\one" }, mutationBusy: false, gitIgnoreCaseInsensitive: true,
    normalizeFileOperationEntries, isFileActionInput: () => false,
    beginFilePointerDrag: (_event, source) => { captured = source; },
    useFileExplorerStore: { getState: () => ({ selectedEntries: [a, b], getActionEntries: () => [a, b] }) },
    selectEntry: () => { selects += 1; },
  });
  handler({ button: 0, pointerType: "mouse", buttons: 1, pointerId: 1, clientX: 10, clientY: 20,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200 }), className: "row", innerHTML: "a", style: {} },
  }, a);
  assert.equal(selects, 0);
  assert.deepEqual(captured.entries, [a, b]);
  assert.equal(captured.project.id, "one");
});

test("file actions and selection are wired to both search views and both tree layouts", () => {
  assert.equal((source.match(/<FileSelectionMenuItems /g) ?? []).length, 3);
  assert.ok(source.includes("onPaste={pasteIntoTarget}"));
  assert.ok(source.includes("onPaste={onPaste}"));
  assert.ok(source.includes('cancelText={t("common.cancel")}'));
  assert.ok(source.includes("action.clipboard"));
  assert.ok(source.includes('if (event.target === event.currentTarget) clearSelection()'));
});

test("mounting another file panel preserves selection and clipboard; changing project clears them", () => {
  const node = findNode((node) => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
    && node.arguments[0]?.getText(ast).includes("selectionProjectKeyRef.current"));
  let cleared = 0;
  const project = { id: "one", path: "E:\\one", remote_path: "", ssh_host_id: null };
  const effect = evaluate(node.arguments[0], {
    project,
    selectionProjectKeyRef: { current: "one:E:\\one::null" },
    setConfirmAction() {}, setInputAction() {}, setRenamingAction() {},
    clearSelection: () => { cleared += 1; },
    useFileExplorerStore: { getState: () => ({ setClipboard: () => { cleared += 1; } }) },
  });
  effect();
  assert.equal(cleared, 0);
  project.path = "E:\\two";
  effect();
  assert.equal(cleared, 2);
});

test("pointer folder drop uses the captured entries and project", () => {
  const moves = [];
  const handler = callback("handlePointerDropOutsideTerminal", {
    getPointerDropTargetPath: () => "dest",
    moveDraggedEntry: (...args) => moves.push(args),
  });
  const project = { id: "one" };
  handler({ ...a, entries: [a, b], project }, { x: 1, y: 2 });
  assert.deepEqual(moves[0], [[a, b], "dest", project]);
});

test("pointer payload rejects stale, case-changed WSL and busy snapshots", () => {
  const project = { id: "one", path: "//wsl.localhost/Ubuntu/home/Case" };
  const current = { project, mutationBusy: false };
  const handler = callback("createPointerPayload", {
    useFileExplorerStore: { getState: () => current },
    isSameProjectFileContext: (left, right) => left.id === right.id,
    fileOperationRootKey: (path) => path,
    createSelectedTerminalDragPayload: (_project, entries) => entries,
  });
  assert.deepEqual(handler({ project: { ...project }, entries: [a, b] }), [a, b]);
  assert.equal(handler({ project: { ...project, path: project.path.toLowerCase() }, entries: [a] }), null);
  assert.equal(handler({ project: { ...project, id: "two" }, entries: [a] }), null);
  current.mutationBusy = true;
  assert.equal(handler({ project, entries: [a] }), null);
});
