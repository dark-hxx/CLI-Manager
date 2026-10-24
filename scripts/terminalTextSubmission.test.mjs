import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-text-submission-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

// Bundle the real boundary, replacing only transport and the application's preference store.
await build({
  entryPoints: [fileURLToPath(new URL("../src/features/terminal/api/terminalTextSubmission.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(tempDir, "submission.mjs"),
  plugins: [{
    name: "submission-boundaries",
    setup(plugin) {
      plugin.onResolve({ filter: /\/TerminalProcessManager$/ }, () => ({ path: "transport", namespace: "fixture" }));
      plugin.onResolve({ filter: /shared\/i18n\/index$/ }, () => ({ path: "i18n", namespace: "fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path === "transport"
          ? `export const terminalProcessManager = { write: (...args) => globalThis.__submissionWrite(...args) };`
          : `export const translateCurrent = (key) => globalThis.__submissionTranslate(key);`,
        loader: "js",
      }));
    },
  }],
});
await build({
  entryPoints: [fileURLToPath(new URL("../node_modules/@xterm/xterm/src/browser/Clipboard.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(tempDir, "xtermClipboard.mjs"),
});

const { registerTerminalTextSubmissionTarget: register, submitTerminalText: submit } =
  await import(pathToFileURL(join(tempDir, "submission.mjs")).href);
const { paste: nativePaste, prepareTextForTerminal, bracketTextForPaste } =
  await import(pathToFileURL(join(tempDir, "xtermClipboard.mjs")).href);
const zh = (await import("../src/shared/i18n/messages/command-tools.zh-CN.ts")).zh;
const en = (await import("../src/shared/i18n/messages/command-tools.en-US.ts")).en;

let writes;
let language;
test.beforeEach(() => {
  writes = [];
  language = zh;
  globalThis.__submissionWrite = async (sessionId, data) => { writes.push({ sessionId, data }); };
  globalThis.__submissionTranslate = (key) => language[key];
});
test.after(() => {
  delete globalThis.__submissionWrite;
  delete globalThis.__submissionTranslate;
});

// Use the installed xterm paste implementation; model only its DOM-free event plumbing.
function attach(sessionId, bracketedPasteMode = true, ignoreBracketedPasteMode = false) {
  const options = { ignoreBracketedPasteMode, disableStdin: false };
  const modes = { bracketedPasteMode };
  const fixture = { pasted: [], inputs: [], normalInput: [], userInputEvents: 0, controller: null };
  const textarea = { value: "previous textarea input" };
  const core = {
    decPrivateModes: modes,
    triggerDataEvent(data, wasUserInput) {
      if (options.disableStdin) return;
      if (wasUserInput) fixture.userInputEvents++;
      if (!fixture.controller.captureInput(data)) fixture.normalInput.push(data);
    },
  };
  const terminal = {
    options,
    paste(text) {
      fixture.pasted.push(text);
      nativePaste(text, textarea, core, { rawOptions: options });
    },
    input(data, wasUserInput = true) {
      fixture.inputs.push(data);
      core.triggerDataEvent(data, wasUserInput);
    },
  };
  fixture.controller = register(sessionId, terminal);
  return Object.assign(fixture, { terminal, modes, options, textarea });
}

test("Codex/Claude paste-enabled terminals receive text then one out-of-paste Enter", async () => {
  const target = attach("tui");
  try {
    await submit("tui", "hello");
    assert.deepEqual(writes, [{ sessionId: "tui", data: "\x1b[200~hello\x1b[201~\r" }]);
    assert.deepEqual(target.pasted, ["hello"]);
    assert.deepEqual(target.inputs, ["\r"]);
    assert.deepEqual(target.normalInput, []);
    assert.equal(target.userInputEvents, 2);
    assert.equal(target.textarea.value, "");
  } finally {
    target.controller.dispose();
  }
});

test("normalization, ESC sanitization and ignore mode match the installed xterm reference", async () => {
  const texts = ["hello", "你好 👩‍💻", "one\ntwo", "one\r\ntwo\rthree", "\n", "  spaced  ",
    "text\x1b[201~\r/quit", "x".repeat(100_000)];
  for (const bracketedPasteMode of [false, true]) {
    for (const ignoreBracketedPasteMode of [false, true]) {
      const target = attach("reference", bracketedPasteMode, ignoreBracketedPasteMode);
      try {
        for (const text of texts) {
          await submit("reference", text);
          const expected = bracketTextForPaste(
            prepareTextForTerminal(text), bracketedPasteMode && !ignoreBracketedPasteMode,
          ) + "\r";
          assert.equal(writes.at(-1).data, expected);
        }
      } finally {
        target.controller.dispose();
      }
    }
  }
});

test("ordinary shells stay unframed and empty templates send only Enter", async () => {
  for (const bracketedPasteMode of [false, true]) {
    const target = attach("shell", bracketedPasteMode);
    try {
      await submit("shell", "");
      assert.equal(writes.at(-1).data, "\r");
      if (!bracketedPasteMode) {
        await submit("shell", "echo hello");
        assert.equal(writes.at(-1).data, "echo hello\r");
      }
    } finally {
      target.controller.dispose();
    }
  }
});

test("mode changes and split-session targeting use live values, not the active pane", async () => {
  const a = attach("pane-a", false);
  const b = attach("pane-b");
  try {
    await submit("pane-a", "first");
    a.modes.bracketedPasteMode = true;
    await submit("pane-a", "second");
    await submit("pane-b", "third");
    a.modes.bracketedPasteMode = false;
    await submit("pane-a", "fourth");
    assert.deepEqual(writes, [
      { sessionId: "pane-a", data: "first\r" },
      { sessionId: "pane-a", data: "\x1b[200~second\x1b[201~\r" },
      { sessionId: "pane-b", data: "\x1b[200~third\x1b[201~\r" },
      { sessionId: "pane-a", data: "fourth\r" },
    ]);
  } finally {
    a.controller.dispose();
    b.controller.dispose();
  }
});

test("stale cleanup cannot unregister a replacement, even for the same terminal object", async () => {
  const target = attach("reattach");
  const old = target.controller;
  target.controller = register("reattach", target.terminal);
  old.dispose();
  try {
    await submit("reattach", "still attached");
    assert.equal(writes.length, 1);
  } finally {
    target.controller.dispose();
  }
  await assert.rejects(submit("reattach", "do not send"));
  assert.equal(writes.length, 1);
});

test("ordinary native input is not captured before or after a submission", async () => {
  const target = attach("keyboard");
  try {
    target.terminal.input("typed before");
    await submit("keyboard", "template");
    target.terminal.input("typed after");
    assert.deepEqual(target.normalInput, ["typed before", "typed after"]);
    assert.deepEqual(writes, [{ sessionId: "keyboard", data: "\x1b[200~template\x1b[201~\r" }]);
  } finally {
    target.controller.dispose();
  }
});

test("disabled stdin rejects without bypassing xterm input policy", async () => {
  const target = attach("readonly");
  target.options.disableStdin = true;
  try {
    await assert.rejects(submit("readonly", "do not send"));
    assert.deepEqual(target.pasted, []);
    assert.deepEqual(target.inputs, []);
    assert.equal(writes.length, 0);
  } finally {
    target.controller.dispose();
  }
});

test("missing onData delivery rejects instead of falling back to raw input", async () => {
  const target = register("unmounted", { options: {}, paste() {}, input() {} });
  try {
    await assert.rejects(submit("unmounted", "do not send"));
    assert.equal(writes.length, 0);
  } finally {
    target.dispose();
  }
});

test("a native paste failure clears capture before subsequent manual input", async () => {
  const target = attach("paste-failure");
  const failure = new Error("native paste failed");
  target.terminal.paste = () => { throw failure; };
  try {
    await assert.rejects(submit("paste-failure", "do not send"), (error) => error === failure);
    target.terminal.input("ordinary input");
    assert.deepEqual(target.normalInput, ["ordinary input"]);
    assert.equal(writes.length, 0);
  } finally {
    target.controller.dispose();
  }
});

test("missing targets fail in both languages without sending raw text", async () => {
  for (const messages of [zh, en]) {
    language = messages;
    await assert.rejects(submit("missing", "do not send"), {
      message: messages["commandTemplate.toast.terminalNotReady"],
    });
  }
  assert.equal(writes.length, 0);
});

test("submission awaits one transport write and propagates failure without retries", async () => {
  let rejectWrite;
  globalThis.__submissionWrite = (sessionId, data) => {
    writes.push({ sessionId, data });
    return new Promise((_, reject) => { rejectWrite = reject; });
  };
  const target = attach("failed");
  try {
    let settled = false;
    const pending = submit("failed", "hello").finally(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    const failure = new Error("PTY disconnected");
    rejectWrite(failure);
    await assert.rejects(pending, (error) => error === failure);
    assert.equal(writes.length, 1);
  } finally {
    target.controller.dispose();
  }
});

test("both template entry points use the shared boundary and input disposal unregisters it", () => {
  const panel = readFileSync(new URL("../src/features/prompts/api/CommandTemplatePanel.tsx", import.meta.url), "utf8");
  const palette = readFileSync(new URL("../src/features/workspace/api/CommandPalette.tsx", import.meta.url), "utf8");
  const input = readFileSync(new URL("../src/features/terminal/hooks/useTerminalInput.ts", import.meta.url), "utf8");
  assert.match(panel, /await submitTerminalText\(activeSessionId, resolved\)/);
  assert.match(palette, /submitTerminalText\(sid, t\.command\)/);
  assert.doesNotMatch(panel + palette, /terminalProcessManager\.write/);
  assert.match(input, /registerTerminalTextSubmissionTarget\(sessionId, terminal\)/);
  assert.match(input, /if \(textSubmission\.captureInput\(data\)\) return/);
  assert.match(input, /dispose: \(\) => \{\s+textSubmission\.dispose\(\)/);
});
