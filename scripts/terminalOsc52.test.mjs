import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-osc52-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

writeFileSync(join(tempDir, "react.mjs"), `
export function useRef(value) { return { current: value }; }
`);
writeFileSync(join(tempDir, "terminalOscPath.mjs"), `
export function parseOsc7Cwd() { return null; }
export function decodeOscPathValue(value) { return value; }
`);
writeFileSync(join(tempDir, "terminalColor.mjs"), `
export function normalizeHexColor(value, fallback) { return value || fallback; }
`);
const parseSource = readFileSync(new URL("../src/lib/terminalOscParse.ts", import.meta.url), "utf8");
const transpiledParse = ts.transpileModule(parseSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "terminalOscParse.ts",
}).outputText
  .replace('from "./terminalOscPath"', 'from "./terminalOscPath.mjs"')
  .replace('from "./terminalColor"', 'from "./terminalColor.mjs"');
writeFileSync(join(tempDir, "terminalOscParse.mjs"), transpiledParse, "utf8");
writeFileSync(join(tempDir, "terminalStore.mjs"), `
export const useTerminalStore = {
  getState() {
    return {
      sessions: [],
      handleShellRuntimeEvent() {},
      updateSessionCwd() {},
    };
  },
};
`);
const hookSource = readFileSync(new URL("../src/hooks/useTerminalOsc.ts", import.meta.url), "utf8");
const transpiledHook = ts.transpileModule(hookSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "useTerminalOsc.ts",
}).outputText
  .replace('from "react"', 'from "./react.mjs"')
  .replace('from "../lib/terminalOscPath"', 'from "./terminalOscPath.mjs"')
  .replace('from "../lib/terminalOscParse"', 'from "./terminalOscParse.mjs"')
  .replace('from "../stores/terminalStore"', 'from "./terminalStore.mjs"');
writeFileSync(join(tempDir, "useTerminalOsc.mjs"), transpiledHook, "utf8");

const parseUrl = pathToFileURL(join(tempDir, "terminalOscParse.mjs")).href;
const hookUrl = pathToFileURL(join(tempDir, "useTerminalOsc.mjs")).href;
const {
  decodeOsc52Payload,
  encodeOsc52Payload,
  formatOsc52Reply,
  matchDcsPrefix,
  parseOsc52Body,
  unwrapTmuxDcsBody,
  OSC52_MAX_BASE64_CHARS,
} = await import(parseUrl);
const { useTerminalOsc } = await import(hookUrl);

const toBase64 = (text) => Buffer.from(text, "utf8").toString("base64");
const osc52 = (text, selection = "c", terminator = "\x07") =>
  `\x1b]52;${selection};${toBase64(text)}${terminator}`;
const tmuxOsc52 = (text, terminator = "\x07") =>
  `\x1bPtmux;\x1b\x1b]52;c;${toBase64(text)}${terminator.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;

const collectCopies = (options = {}) => {
  const copied = [];
  const osc = useTerminalOsc({
    sessionId: options.sessionId ?? "session-osc52",
    osPlatformRef: { current: "windows" },
    onOsc52Write: (text) => copied.push(text),
  });
  return { osc, copied };
};

test("parseOsc52Body writes clipboard, primary, and empty selections", () => {
  assert.deepEqual(parseOsc52Body(`52;c;${toBase64("Hello")}`), {
    kind: "write",
    text: "Hello",
    selection: "c",
  });
  assert.deepEqual(parseOsc52Body(`52;p;${toBase64("Hi")}`), {
    kind: "write",
    text: "Hi",
    selection: "p",
  });
  assert.deepEqual(parseOsc52Body(`52;;${toBase64("EmptyPc")}`), {
    kind: "write",
    text: "EmptyPc",
    selection: "",
  });
});

test("parseOsc52Body distinguishes query, clear, and invalid payloads", () => {
  assert.deepEqual(parseOsc52Body("52;c;?"), { kind: "query", selection: "c" });
  assert.deepEqual(parseOsc52Body("52;c;"), { kind: "clear" });
  assert.deepEqual(parseOsc52Body("52"), { kind: "clear" });
  assert.deepEqual(parseOsc52Body("52;c;%%%"), { kind: "invalid" });
  assert.equal(parseOsc52Body("10;?"), null);
  assert.equal(parseOsc52Body("8;;https://example.com"), null);
});

test("decodeOsc52Payload accepts wrapped UTF-8 base64 and rejects junk", () => {
  assert.equal(decodeOsc52Payload(toBase64("你好")), "你好");
  assert.equal(decodeOsc52Payload("SGVs\n bG8="), "Hello");
  assert.equal(decodeOsc52Payload("SGk"), "Hi");
  assert.equal(decodeOsc52Payload("TQ"), "M");
  assert.equal(decodeOsc52Payload(""), null);
  assert.equal(decodeOsc52Payload("A"), null);
  assert.equal(decodeOsc52Payload("TQ="), null);
  assert.equal(decodeOsc52Payload("!!!!"), null);
  assert.equal(decodeOsc52Payload("A".repeat(OSC52_MAX_BASE64_CHARS + 4)), null);
});

test("live PTY output enables OSC 52 copies and replay disables them", () => {
  const displaySource = readFileSync(new URL("../src/hooks/useTerminalDisplay.ts", import.meta.url), "utf8");
  const terminalSource = readFileSync(new URL("../src/components/XTermTerminal.tsx", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const settingsSource = readFileSync(new URL("../src/stores/settingsStore.ts", import.meta.url), "utf8");
  assert.match(displaySource, /applyOsc52:\s*payload\.kind !== "replay" && payload\.kind !== "reset"/);
  assert.match(displaySource, /normalizeOutputRef\.current\(rawText, \{ applyOsc52: false \}\)/);
  assert.match(terminalSource, /osc52ClipboardEnabled/);
  assert.match(terminalSource, /osc52ClipboardQueryEnabled/);
  assert.match(terminalSource, /formatOsc52Reply/);
  assert.match(terminalSource, /readTextFromClipboard/);
  assert.match(terminalSource, /OSC52_MAX_PENDING_CLIPBOARD_ACTIONS/);
  assert.match(
    terminalSource,
    /const text = await readTextFromClipboard\(\);\s+if \(!useSettingsStore\.getState\(\)\.osc52ClipboardQueryEnabled\) return;/,
  );
  assert.match(terminalSource, /copyTerminalSelection/);
  assert.match(appSource, /blockChromiumInspect/);
  assert.match(appSource, /target\.closest\("\.xterm"\)/);
  assert.match(settingsSource, /osc52ClipboardQueryEnabled: false/);
});

test("OSC 52 payload encoding round-trips UTF-8 text", () => {
  assert.equal(decodeOsc52Payload(encodeOsc52Payload("你好\nline")), "你好\nline");
  assert.equal(formatOsc52Reply("Hi", "c"), `\x1b]52;c;${encodeOsc52Payload("Hi")}\x07`);
});

test("OSC 52 payload encoding round-trips a large payload", () => {
  const largeText = "x".repeat(100_000);
  assert.equal(decodeOsc52Payload(encodeOsc52Payload(largeText)), largeText);
});

test("OSC 52 query replies stay inside the protocol payload limit", () => {
  assert.notEqual(formatOsc52Reply("x".repeat(1_500_000)), null);
  assert.equal(formatOsc52Reply("x".repeat(1_500_001)), null);
  assert.equal(formatOsc52Reply("😀".repeat(375_001)), null);
});

test("tmux DCS prefix matching and ESC unwrapping", () => {
  assert.equal(matchDcsPrefix("\x1bPtmux;inner\x1b\\", 0).kind, "tmux");
  assert.equal(matchDcsPrefix("\x1bP0;1|other\x1b\\", 0).kind, "other");
  assert.equal(matchDcsPrefix("\x1bPtmux", 0).kind, "partial");
  assert.equal(matchDcsPrefix("hello", 0).kind, "none");
  assert.equal(unwrapTmuxDcsBody("\x1b\x1b]52;c;QQ==\x07"), "\x1b]52;c;QQ==\x07");
});

test("live OSC 52 is stripped and copied for BEL and ST terminators", () => {
  const { osc, copied } = collectCopies();
  assert.equal(osc.normalizeTerminalOutput(`before${osc52("Hello")}after`), "beforeafter");
  assert.equal(osc.normalizeTerminalOutput(`x${osc52("World", "c", "\x1b\\")}y`), "xy");
  assert.deepEqual(copied, ["Hello", "World"]);
});

test("OSC 52 query and clear do not write the host clipboard", () => {
  const queried = [];
  const copied = [];
  const osc = useTerminalOsc({
    sessionId: "session-query",
    osPlatformRef: { current: "windows" },
    onOsc52Write: (text) => copied.push(text),
    onOsc52Query: (selection) => queried.push(selection),
  });
  assert.equal(osc.normalizeTerminalOutput("\x1b]52;c;?\x07keep"), "keep");
  assert.equal(osc.normalizeTerminalOutput("\x1b]52;p;?\x07"), "");
  assert.equal(osc.normalizeTerminalOutput("\x1b]52;c;\x07"), "");
  assert.deepEqual(copied, []);
  assert.deepEqual(queried, ["c", "p"]);
});

test("disabled OSC 52 still strips sequences without writing or answering", () => {
  const queried = [];
  const copied = [];
  const osc = useTerminalOsc({
    sessionId: "session-disabled",
    osPlatformRef: { current: "windows" },
    onOsc52Write: (text) => copied.push(text),
    onOsc52Query: (selection) => queried.push(selection),
  });
  assert.equal(
    osc.normalizeTerminalOutput(`pre${osc52("secret")}\x1b]52;c;?\x07`, { applyOsc52: false }),
    "pre",
  );
  assert.deepEqual(copied, []);
  assert.deepEqual(queried, []);
});

test("invalid OSC 52 is stripped without copying", () => {
  const { osc, copied } = collectCopies();
  assert.equal(osc.normalizeTerminalOutput("\x1b]52;c;%%%\x07ok"), "ok");
  assert.deepEqual(copied, []);
});

test("tmux DCS-wrapped OSC 52 is unwrapped, stripped, and copied", () => {
  const { osc, copied } = collectCopies();
  assert.equal(osc.normalizeTerminalOutput(`pre${tmuxOsc52("tmux-copy")}post`), "prepost");
  assert.deepEqual(copied, ["tmux-copy"]);
});

test("OSC 52 copies survive every daemon frame split", () => {
  const input = `visible${osc52("chunked 中文")}`;
  for (let split = 0; split <= input.length; split += 1) {
    const { osc, copied } = collectCopies({ sessionId: `split-${split}` });
    const actual = osc.normalizeTerminalOutput(input.slice(0, split))
      + osc.normalizeTerminalOutput(input.slice(split));
    assert.equal(actual, "visible", `split at ${split}`);
    assert.deepEqual(copied, ["chunked 中文"], `copy at split ${split}`);
  }
});

test("tmux OSC 52 with an ST terminator survives every daemon frame split", () => {
  const input = `a${tmuxOsc52("DCS", "\x1b\\")}b`;
  for (let split = 0; split <= input.length; split += 1) {
    const { osc, copied } = collectCopies({ sessionId: `tmux-split-${split}` });
    const actual = osc.normalizeTerminalOutput(input.slice(0, split))
      + osc.normalizeTerminalOutput(input.slice(split));
    assert.equal(actual, "ab", `tmux split at ${split}`);
    assert.deepEqual(copied, ["DCS"], `tmux copy at split ${split}`);
  }
});

test("replay frames strip OSC 52 without writing the clipboard", () => {
  const { osc, copied } = collectCopies();
  assert.equal(
    osc.normalizeTerminalOutput(`hist${osc52("should-not-copy")}`, { applyOsc52: false }),
    "hist",
  );
  assert.deepEqual(copied, []);
});

test("an interrupted OSC 52 fails open before following output", () => {
  const piUserMessage = "\x1b]133;A\x07prompt";
  const { osc, copied } = collectCopies();
  const actual = osc.normalizeTerminalOutput("\x1b]52;c;QQ")
    + osc.normalizeTerminalOutput(piUserMessage);
  assert.equal(actual, `\x1b]52;c;QQ${piUserMessage}`);
  assert.deepEqual(copied, []);
});

test("OSC 52 does not consume a following Pi integration sequence", () => {
  const piUserMessage = "\x1b]133;A\x07prompt";
  const input = `${osc52("ok")}${piUserMessage}`;
  const { osc, copied } = collectCopies();
  assert.equal(osc.normalizeTerminalOutput(input), piUserMessage);
  assert.deepEqual(copied, ["ok"]);
});

test("a long complete OSC 52 copy is accepted in one frame", () => {
  const payload = "line\n".repeat(4000);
  const { osc, copied } = collectCopies();
  assert.equal(osc.normalizeTerminalOutput(`ok${osc52(payload)}`), "ok");
  assert.deepEqual(copied, [payload]);
});

test("other DCS sequences are left untouched", () => {
  const { osc, copied } = collectCopies();
  const dcs = "\x1bP0;1|status\x1b\\";
  assert.equal(osc.normalizeTerminalOutput(`x${dcs}y`), `x${dcs}y`);
  assert.deepEqual(copied, []);
});
