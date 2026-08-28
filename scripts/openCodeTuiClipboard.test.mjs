import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-opencode-tui-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

function transpileModule(fileName) {
  const source = readFileSync(new URL(`../src/${fileName}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const outputPath = join(tempDir, fileName.replaceAll("/", "-").replace(/\.ts$/, ".mjs"));
  writeFileSync(outputPath, output, "utf8");
  return import(pathToFileURL(outputPath).href);
}

const [{ isOpenCodeTerminalContext }, { attachOpenCodeTuiClipboard }] = await Promise.all([
  transpileModule("terminal/browser/TerminalCliContext.ts"),
  transpileModule("terminal/browser/OpenCodeTuiClipboard.ts"),
]);

function context(overrides = {}) {
  return {
    projectTool: "",
    sessionTool: "",
    startupCmd: "",
    titleTool: "",
    outputHint: "",
    ...overrides,
  };
}

class FakeContainer extends EventTarget {
  contains() {
    return true;
  }
}

function keyEvent(key, modifiers = {}) {
  const event = new Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    ctrlKey: { value: Boolean(modifiers.ctrlKey) },
    shiftKey: { value: Boolean(modifiers.shiftKey) },
    altKey: { value: Boolean(modifiers.altKey) },
    metaKey: { value: Boolean(modifiers.metaKey) },
  });
  return event;
}

test("OpenCode context uses structured tool values and strict executable tokens", () => {
  assert.equal(isOpenCodeTerminalContext(context({ projectTool: "opencode" })), true);
  assert.equal(isOpenCodeTerminalContext(context({ sessionTool: "opencode.cmd" })), true);
  assert.equal(isOpenCodeTerminalContext(context({ startupCmd: '& "C:\\Program Files\\OpenCode\\opencode.exe" --session ses_a' })), true);
  assert.equal(isOpenCodeTerminalContext(context({ startupCmd: "my-opencode-wrapper --session ses_a" })), false);
  assert.equal(isOpenCodeTerminalContext(context({ projectTool: "claude" })), false);
  assert.equal(isOpenCodeTerminalContext(context({ sessionTool: "codex" })), false);
  assert.equal(isOpenCodeTerminalContext(context({ titleTool: "opencode" })), false);
});

test("explicit sessionTool takes precedence over project/startup OpenCode hints", () => {
  assert.equal(isOpenCodeTerminalContext(context({ sessionTool: "codex", projectTool: "opencode" })), false);
  assert.equal(isOpenCodeTerminalContext(context({ sessionTool: "claude", startupCmd: "opencode" })), false);
  assert.equal(isOpenCodeTerminalContext(context({ sessionTool: "pi", projectTool: "opencode", startupCmd: "opencode" })), false);
  assert.equal(isOpenCodeTerminalContext(context({ sessionTool: "opencode", projectTool: "codex" })), true);
  assert.equal(isOpenCodeTerminalContext(context({ sessionTool: "grok", projectTool: "opencode" })), false);
});

test("CC/cx/grok/pi contexts never match OpenCode when session classification is explicit", () => {
  assert.equal(isOpenCodeTerminalContext(context({ sessionTool: "cx", startupCmd: "opencode" })), false);
  assert.equal(isOpenCodeTerminalContext(context({ sessionTool: "cc", startupCmd: "opencode" })), false);
  assert.equal(isOpenCodeTerminalContext(context({ sessionTool: "grok", projectTool: "opencode" })), false);
  assert.equal(isOpenCodeTerminalContext(context({ sessionTool: "pi", projectTool: "opencode" })), false);
});

function attachWithTestDoubles(options = {}) {
  const state = {
    selection: "",
    copied: [],
    cleared: 0,
    inputCleared: 0,
    focused: 0,
    pasted: [],
    active: true,
    visible: true,
    inputFocus: true,
    mac: false,
    readText: "clipboard-text",
    ...options.state,
  };
  const disposed = { value: false };
  const container = options.container ?? new FakeContainer();
  const terminal = {
    hasSelection: () => Boolean(state.selection),
    getSelection: () => state.selection,
    clearSelection: () => { state.cleared += 1; state.selection = ""; },
  };
  const dispose = attachOpenCodeTuiClipboard({
    container,
    terminal,
    isActive: () => state.active,
    isVisible: () => state.visible,
    hasInputFocus: () => state.inputFocus,
    isMac: () => state.mac,
    readClipboardText: async () => state.readText,
    pasteText: (text) => state.pasted.push(text),
    wrapMultilinePaste: (text) => `[wrapped:${text}]`,
    copyText: async (text) => { state.copied.push(text); },
    clearInputSelection: () => { state.inputCleared += 1; },
    focusTerminal: () => { state.focused += 1; },
    logError: () => assert.fail("unexpected error"),
  });
  return { container, state, dispose, terminal };
}

test("OpenCode TUI Ctrl+C copies selection and clears both selection states", async () => {
  const { container, state, dispose } = attachWithTestDoubles({ state: { selection: "selected text" } });
  const event = keyEvent("c", { ctrlKey: true });
  container.dispatchEvent(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(state.copied, ["selected text"]);
  assert.equal(state.cleared, 1);
  assert.equal(state.inputCleared, 1);
  assert.equal(state.focused, 1);
  dispose();
});

test("OpenCode TUI Ctrl+C without selection is not intercepted", () => {
  const { container, state, dispose } = attachWithTestDoubles();
  let prevented = false;
  container.addEventListener("keydown", () => { prevented = event.defaultPrevented; }, { once: true });
  const event = keyEvent("c", { ctrlKey: true });
  container.dispatchEvent(event);
  assert.equal(prevented, false);
  assert.deepEqual(state.copied, []);
  dispose();
});

test("OpenCode TUI Ctrl+V and Ctrl+Shift+V paste once with multiline wrapping", async () => {
  const { container, state, dispose } = attachWithTestDoubles();
  container.dispatchEvent(keyEvent("v", { ctrlKey: true }));
  container.dispatchEvent(keyEvent("v", { ctrlKey: true, shiftKey: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.pasted, ["clipboard-text", "[wrapped:clipboard-text]"]);
  dispose();
});

test("OpenCode TUI clipboard ignores inactive, hidden, or unfocused terminals", () => {
  for (const mode of ["active", "visible", "inputFocus", "mac"]) {
    const { container, state, dispose } = attachWithTestDoubles({ state: { selection: "sel" } });
    if (mode === "active") state.active = false;
    if (mode === "visible") state.visible = false;
    if (mode === "inputFocus") state.inputFocus = false;
    if (mode === "mac") state.mac = true;
    const c = keyEvent("c", { ctrlKey: true });
    container.dispatchEvent(c);
    assert.equal(c.defaultPrevented, false, `${mode} should not intercept`);
    assert.deepEqual(state.copied, [], `${mode} should not copy`);
    dispose();
  }
});

test("dispose removes the OpenCode TUI clipboard listener", () => {
  const { container, state, dispose } = attachWithTestDoubles({ state: { selection: "sel" } });
  dispose();
  const c = keyEvent("c", { ctrlKey: true });
  container.dispatchEvent(c);
  assert.equal(c.defaultPrevented, false);
  assert.deepEqual(state.copied, []);
});

test("macOS Ctrl+C and Cmd+C are not intercepted by the OpenCode module", () => {
  const { container, state, dispose } = attachWithTestDoubles({ state: { selection: "sel", mac: true } });
  const ctrlC = keyEvent("c", { ctrlKey: true });
  container.dispatchEvent(ctrlC);
  assert.equal(ctrlC.defaultPrevented, false);
  const cmdC = keyEvent("c", { metaKey: true });
  container.dispatchEvent(cmdC);
  assert.equal(cmdC.defaultPrevented, false);
  assert.deepEqual(state.copied, []);
  dispose();
});
