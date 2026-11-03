import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../src/shared/lib/usePaneResidency.ts").replace(/^import .*;\r?\n/m, "");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const exports = {}, timers = new Map();
  let state, deps, cleanup;
  runInNewContext(code, { exports,
    useState: initial => { state ??= initial; return [state, value => { state = value; }]; },
    useEffect: (work, nextDeps) => {
      if (deps && deps.every((d, i) => d === nextDeps[i])) return;
      cleanup?.(); deps = nextDeps; cleanup = work();
    },
    setTimeout: (callback, delay) => { const token = {}; timers.set(token, { callback, delay }); return token; },
    clearTimeout: token => timers.delete(token),
  });
  return { render: visible => exports.usePaneResidency(visible), timers, dispose: () => cleanup?.() };
}
test("hidden views cool after the grace period, visible split panes are immediate, cleanup cancels timers", () => {
  const h = harness();
  assert.equal(h.render(false), false);
  assert.equal(h.render(true), true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.render(false), true);
  const pending = [...h.timers.values()][0];
  assert.equal(pending.delay, 10000);
  pending.callback();
  assert.equal(h.render(false), false);
  assert.equal(h.render(true), true);
  h.render(false); h.dispose();
  assert.equal(h.timers.size, 0);
});
test("pane wiring protects active diff/confirm/navigation and uses visibility rather than global focus", () => {
  const pane = read("../src/features/terminal/components/PaneLeafView.tsx");
  assert.match(pane, /isVisible=\{!historyActive && isLayoutVisible && session.id === effectivePaneActiveSessionId\}/);
  const view = read("../src/features/files/components/FileEditorPaneView.tsx");
  assert.match(view, /usePaneResidency\(props.isVisible \|\| Boolean\(props.activeDiff\)/);
  assert.match(view, /props.pendingAction !== null/);
  assert.match(view, /Boolean\(props.pendingMarkdownNavigation\)/);
  const editorController = read("../src/features/files/hooks/useFileEditorController.ts");
  assert.match(editorController, /attemptedHydrationsRef.current.has\(visibleFile\)/);
  assert.match(editorController, /!remoteFilesReady/);
  const controller = read("../src/features/terminal/hooks/useXTermController.ts");
  assert.match(controller, /Hidden terminals stay attached and continue parsing output/);
  const display = read("../src/features/terminal/hooks/useTerminalDisplay.ts");
  assert.match(display, /enabled \? HIDDEN_WEBGL_DISPOSE_DELAY_MS : 30_000/);
});
