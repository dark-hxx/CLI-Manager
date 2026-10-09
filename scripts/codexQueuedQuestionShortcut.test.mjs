import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/features/terminal/hooks/useXTermController.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("useXTermController.ts", source, ts.ScriptTarget.Latest, true);
let callback;
function visit(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "attachCustomKeyEventHandler") callback = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback, "exercise the actual xterm callback, not a duplicate policy");
const compiled = ts.transpileModule(`module.exports = ${callback.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(codex, hasDraft) {
  const calls = [];
  const sessionContext = { sessionTool: codex ? "codex" : "powershell" };
  const terminal = { buffer: { active: { type: "normal" } } };
  const module = { exports: null };
  vm.runInNewContext(compiled, {
    module, terminal, osPlatformRef: { current: "windows" },
    getSessionToolContext: () => sessionContext,
    isCodexSession: (context, target) => {
      assert.equal(context, sessionContext);
      assert.equal(target, terminal, "live viewport detection must be available for manual Codex launches");
      return codex;
    },
    inputSelection: {
      clearInputSelectionState: () => calls.push("clear"),
      extendKeyboardInputSelection: (direction) => calls.push(hasDraft ? `select:${direction}` : "empty-selection"),
      collapseKeyboardInputSelection: () => false,
    },
    useSettingsStore: { getState: () => ({ keyboardShortcuts: { copyTerminalSelection: "", scrollToBottom: "", pageUp: "", pageDown: "" } }) },
    eventToCombo: () => "",
    acceptSuggestion: () => false,
  });
  return { handle: module.exports, calls };
}

function key(name, overrides = {}) {
  return { type: "keydown", key: name, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false,
    prevented: false, preventDefault() { this.prevented = true; }, ...overrides };
}

for (const arrow of ["ArrowLeft", "ArrowRight"]) {
  for (const hasDraft of [false, true]) {
    test(`Codex ${arrow} with ${hasDraft ? "draft" : "empty input"} reaches xterm with Shift intact`, () => {
      const { handle, calls } = harness(true, hasDraft);
      const event = key(arrow);
      assert.equal(handle(event), true);
      assert.equal(event.prevented, false);
      assert.equal(event.shiftKey, true);
      assert.deepEqual(calls, ["clear"], "must not send plain arrows or create a synthetic input selection");
    });
  }
  test(`ordinary shell ${arrow} retains selection behavior`, () => {
    const { handle, calls } = harness(false, true);
    const event = key(arrow);
    assert.equal(handle(event), false);
    assert.equal(event.prevented, true);
    assert.deepEqual(calls, [`select:${arrow === "ArrowLeft" ? -1 : 1}`]);
  });
}

test("release and other modifier combinations pass through without touching input selection", () => {
  for (const overrides of [{ type: "keyup" }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: false }]) {
    const { handle, calls } = harness(true, false);
    const event = key("ArrowLeft", overrides);
    assert.equal(handle(event), true);
    assert.equal(event.prevented, false);
    assert.deepEqual(calls, []);
  }
});

const shortcutsSource = readFileSync(new URL("../src/features/workspace/api/useKeyboardShortcuts.ts", import.meta.url), "utf8");
const shortcutsAst = ts.createSourceFile("useKeyboardShortcuts.ts", shortcutsSource, ts.ScriptTarget.Latest, true);
// 只替换外部依赖，执行实际 Hook 及其捕获监听器，防止仅测试 xterm 而漏掉更早的全局动作。
const shortcutsCompiled = ts.transpileModule(shortcutsAst.statements
  .filter((node) => !ts.isImportDeclaration(node))
  .map((node) => node.getText(shortcutsAst)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

// Store 和窗口仅记录可见副作用；按键匹配、作用域和监听阶段均来自实际实现。
function globalHarness({ modifier = "Shift", sessionCount = 2, viewMode = "standard", bindings = {} } = {}) {
  const calls = [];
  const listeners = new Map();
  let terminalReads = 0;
  const shortcuts = {
    commandPalette: "", toggleTerminalFullscreen: "", toggleSidebar: "", sessionHistory: "", copyAi: "",
    nextTab: `${modifier}+ArrowRight`, prevTab: `${modifier}+ArrowLeft`,
    closeTerminal: "Ctrl+W", newTerminal: "Ctrl+T", ...bindings,
  };
  const terminalState = {
    sessions: Array.from({ length: sessionCount }, (_, index) => ({ id: `session-${index}` })),
    activeSessionId: "session-0",
    getNextSessionIdForShortcut: (delta) => { calls.push(`navigate:${delta}`); return "target-session"; },
    setActive: (id) => calls.push(`activate:${id}`),
    createSession: () => calls.push("create"),
  };
  const module = { exports: {} };
  vm.runInNewContext(shortcutsCompiled, {
    module, exports: module.exports,
    useRef: (current) => ({ current }),
    useEffect: (effect) => effect(),
    useSettingsStore: (selector) => selector({ keyboardShortcuts: shortcuts, viewMode }),
    useTerminalStore: { getState: () => { terminalReads += 1; return terminalState; } },
    useCommandPaletteStore: { getState: () => ({ toggle: () => calls.push("palette") }) },
    useHistoryStore: { getState: () => ({
      isOpen: false,
      openHistory: () => calls.push("history"),
      triggerGlobalSearchFocus: () => calls.push("history-focus"),
    }) },
    TERMINAL_TAB_CLOSE_REQUEST_EVENT: "terminal-close-request",
    CustomEvent: class {
      constructor(type, { detail }) { this.type = type; this.detail = detail; }
    },
    window: {
      addEventListener: (type, handle, capture) => listeners.set(type, { handle, capture }),
      removeEventListener: () => {},
      dispatchEvent: (event) => calls.push(`${event.type}:${event.detail.sessionIds.join(",")}`),
    },
  });
  module.exports.useKeyboardShortcuts({
    onToggleSidebar: () => calls.push("sidebar"),
    onToggleTerminalFullscreen: () => calls.push("fullscreen"),
  });
  const listener = listeners.get("keydown");
  assert.equal(listener?.capture, true, "exercise the listener that runs before xterm");
  return { handle: listener.handle, calls, get terminalReads() { return terminalReads; } };
}

// 终端 textarea、终端容器和普通编辑控件具有不同的祖先作用域。
function scopedKey(name, scope = "terminal", overrides = {}) {
  const tagName = {
    terminal: "TEXTAREA", "terminal-container": "DIV", input: "INPUT", textarea: "TEXTAREA",
    select: "SELECT", editable: "DIV", "file-editor": "TEXTAREA", outside: "BUTTON",
  }[scope];
  return key(name, {
    target: {
      tagName,
      closest(selector) {
        const matches = selector === ".xterm" ? scope.startsWith("terminal")
          : selector === ".ui-file-editor-pane" ? scope === "file-editor"
            : selector === "[contenteditable='true']" && scope === "editable";
        return matches ? this : null;
      },
    },
    stopped: false,
    stopPropagation() { this.stopped = true; },
    ...overrides,
  });
}

for (const arrow of ["ArrowLeft", "ArrowRight"]) {
  const delta = arrow === "ArrowLeft" ? -1 : 1;
  for (const codex of [true, false]) {
    for (const hasDraft of [false, true]) {
      for (const sessionCount of [1, 3]) {
        test(`Shift ${arrow}: ${codex ? "Codex" : "shell"}, ${hasDraft ? "draft" : "empty"}, ${sessionCount} sessions`, () => {
          const global = globalHarness({ sessionCount });
          const terminal = harness(codex, hasDraft);
          const event = scopedKey(arrow);
          global.handle(event);
          assert.equal(event.prevented, false, "the global listener must not cancel terminal input");
          assert.equal(event.stopped, false);
          assert.deepEqual(global.calls, [], "must not switch tabs or move focus before xterm");
          assert.equal(global.terminalReads, 0, "route by the focused DOM target, not the active session snapshot");
          assert.equal(terminal.handle(event), codex);
          assert.equal(event.prevented, !codex);
          assert.equal(event.shiftKey, true);
          assert.deepEqual(terminal.calls, codex ? ["clear"] : [hasDraft ? `select:${delta}` : "empty-selection"]);
        });
      }
    }
  }

  test(`Shift ${arrow} outside the terminal retains tab switching`, () => {
    const global = globalHarness();
    const event = scopedKey(arrow, "outside");
    global.handle(event);
    assert.equal(event.prevented, true);
    assert.deepEqual(global.calls, [`navigate:${delta}`, "activate:target-session"]);
  });

  test(`Shift ${arrow} remains available to non-terminal editing controls`, () => {
    for (const scope of ["input", "textarea", "select", "editable", "file-editor"]) {
      const global = globalHarness();
      const event = scopedKey(arrow, scope);
      global.handle(event);
      assert.equal(event.prevented, false, scope);
      assert.deepEqual(global.calls, [], scope);
    }
  });

  test(`terminal Shift ${arrow} takes priority over individually recorded global bindings`, () => {
    for (const action of ["commandPalette", "toggleTerminalFullscreen", "toggleSidebar", "sessionHistory", "closeTerminal"]) {
      const global = globalHarness({ bindings: { [action]: `Shift+${arrow}` } });
      const event = scopedKey(arrow, "terminal-container");
      global.handle(event);
      assert.equal(event.prevented, false, action);
      assert.equal(event.stopped, false, action);
      assert.deepEqual(global.calls, [], action);
    }
  });

  for (const [modifier, overrides] of [
    ["Alt", { shiftKey: false, altKey: true }],
    ["Ctrl", { shiftKey: false, ctrlKey: true }],
    ["Ctrl+Shift", { ctrlKey: true }],
    ["Shift+Alt", { altKey: true }],
    ["Shift+Meta", { metaKey: true }],
  ]) {
    test(`terminal ${modifier}+${arrow} retains its configured tab action`, () => {
      const global = globalHarness({ modifier });
      const event = scopedKey(arrow, "terminal", overrides);
      global.handle(event);
      assert.equal(event.prevented, true);
      assert.deepEqual(global.calls, [`navigate:${delta}`, "activate:target-session"]);
    });
  }

  test(`plain ${arrow} reaches the terminal without global or selection actions`, () => {
    const global = globalHarness();
    const terminal = harness(true, false);
    const event = scopedKey(arrow, "terminal", { shiftKey: false });
    global.handle(event);
    assert.equal(event.prevented, false);
    assert.deepEqual(global.calls, []);
    assert.equal(terminal.handle(event), true);
    assert.deepEqual(terminal.calls, []);
  });
}

test("Ctrl+W in the terminal still requests the existing close confirmation", () => {
  const global = globalHarness();
  const event = scopedKey("w", "terminal", { shiftKey: false, ctrlKey: true });
  global.handle(event);
  assert.equal(event.prevented, true);
  assert.deepEqual(global.calls, ["terminal-close-request:session-0"]);
});

test("compact mode still disables global tab switching and closing", () => {
  for (const event of [
    scopedKey("ArrowLeft", "terminal"),
    scopedKey("ArrowRight", "terminal", { shiftKey: false, altKey: true }),
    scopedKey("w", "terminal", { shiftKey: false, ctrlKey: true }),
  ]) {
    const global = globalHarness({ modifier: "Alt", viewMode: "compact" });
    global.handle(event);
    assert.equal(event.prevented, false);
    assert.deepEqual(global.calls, []);
  }
});
