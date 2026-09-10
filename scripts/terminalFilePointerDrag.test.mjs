import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/features/terminal/api/useTerminalFilePointerDrag.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const project = { id: "one", name: "One", path: "E:\\one" };
const entry = { path: "a.txt", kind: "file" };

// Execute the real shared hook with deterministic hooks/DOM adapters, without starting a UI.
function harness(options = {}, terminalDrop = false) {
  const effects = [], refs = [], previews = [], payloads = [], ended = [], removals = [];
  const dependencies = {
    react: {
      useCallback: (fn) => fn,
      useEffect: (fn, deps) => effects.push({ fn, deps }),
      useRef: (value) => { const ref = { current: value }; refs.push(ref); return ref; },
      useState: (value) => [value, (next) => previews.push(next)],
    },
    "react/jsx-runtime": { jsx() {}, jsxs() {} },
    "../../../shared/ui/Portal": { Portal() {} },
    "../../workspace/api/dragInteraction": { POINTER_DRAG_START_PX: 5 },
    "./terminalFileDrag": {
      createTerminalFileDragPayload: (scope, path, kind) => ({ scope, path, kind }),
      beginTerminalFileDrag: (payload) => payloads.push(payload),
      commitTerminalFileDragDrop: () => terminalDrop,
      endTerminalFileDrag: () => ended.push(true),
      getTerminalFileDropZoneIdAtPoint: () => null,
      updateTerminalFileDragPointFromEvent() {},
    },
  };
  const module = { exports: {} };
  const style = { removeProperty: (property) => removals.push(property) };
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`, {
    window: { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1 },
    document: { body: { style } },
  })((name) => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  const handlers = module.exports.useTerminalFilePointerDrag({ project, ...options });
  return { handlers, effects, refs, previews, payloads, ended, removals, style };
}

function event(overrides = {}) {
  return {
    button: 0, buttons: 1, pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10,
    currentTarget: {
      dataset: {}, className: "row", innerHTML: "a.txt", style: {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200 }),
      setPointerCapture() {}, releasePointerCapture() {},
    },
    preventDefault() {}, stopPropagation() {}, ...overrides,
  };
}

function start(h, item = entry) {
  h.handlers.handlePointerDown(event(), item);
  h.handlers.handlePointerMove(event({ clientX: 30 }));
}

test("shared hook retains the default single-item Git drag payload", () => {
  const drops = [];
  const h = harness({ onDropOutsideTerminal: (item) => drops.push(item) });
  start(h);
  assert.equal(h.payloads.length, 1);
  assert.deepEqual(h.payloads[0], { scope: project, path: entry.path, kind: entry.kind });
  h.handlers.handlePointerUp(event({ clientX: 30 }));
  assert.deepEqual(drops, [entry]);
  assert.equal(h.ended.length, 1);
});

test("batch drag uses the custom snapshot payload and captured count label", () => {
  const batch = { ...entry, entries: [entry, { path: "b.txt", kind: "file" }] };
  const payload = { text: "a.txt b.txt", absolutePath: "E:\\one\\a.txt E:\\one\\b.txt" };
  const h = harness({
    createPayload: (item) => { assert.equal(item, batch); return payload; },
    previewLabel: (item) => `${item.entries.length} selected`,
  });
  start(h, batch);
  assert.equal(h.payloads[0], payload);
  assert.equal(h.previews[0].source.label, "2 selected");
});

test("null custom payload cancels stale/busy snapshots before starting a drag", () => {
  const h = harness({ createPayload: () => null });
  start(h);
  assert.equal(h.payloads.length, 0);
  assert.equal(h.refs[0].current, null);
  assert.equal(h.style.userSelect, undefined);
});

test("terminal drop does not fall through to filesystem drop", () => {
  const h = harness({ onDropOutsideTerminal: () => assert.fail("unexpected filesystem move") }, true);
  start(h);
  const up = event({ clientX: 30 });
  h.handlers.handlePointerUp(up);
  assert.equal(up.currentTarget.dataset.pointerDragHandled, "true");
  assert.equal(h.ended.length, 0);
  assert.equal(h.refs[0].current, null);
});

test("scope cleanup cancels only its own drag and preserves another panel's DOM state", () => {
  const h = harness({ resetKey: "one" });
  const effect = h.effects.find(({ deps }) => deps.includes("one"));
  assert.ok(effect, "scope changes must register cleanup");
  effect.fn()();
  assert.equal(h.ended.length, 0);
  assert.equal(h.removals.length, 0);
  start(h);
  effect.fn()();
  assert.equal(h.ended.length, 1);
  assert.deepEqual(h.removals, ["user-select"]);
  assert.equal(h.refs[0].current, null);
});

test("modifier selection does not start a pointer drag", () => {
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    const h = harness();
    h.handlers.handlePointerDown(event({ [modifier]: true }), entry);
    h.handlers.handlePointerMove(event({ clientX: 30 }));
    assert.equal(h.payloads.length, 0);
    assert.equal(h.refs[0].current, null);
  }
});
