import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-osc-"));
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
const parseSource = readFileSync(new URL("../src/features/terminal/lib/terminalOscParse.ts", import.meta.url), "utf8");
const transpiledParse = ts.transpileModule(parseSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "terminalOscParse.ts",
}).outputText
  .replace('from "./terminalOscPath"', 'from "./terminalOscPath.mjs"')
  .replace('from "../../../shared/lib/terminalColor"', 'from "./terminalColor.mjs"');
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
const source = readFileSync(new URL("../src/features/terminal/hooks/useTerminalOsc.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "useTerminalOsc.ts",
}).outputText
  .replace('from "react"', 'from "./react.mjs"')
  .replace('from "../lib/terminalOscPath"', 'from "./terminalOscPath.mjs"')
  .replace('from "../lib/terminalOscParse"', 'from "./terminalOscParse.mjs"')
  .replace('from "../state"', 'from "./terminalStore.mjs"');
const hookPath = join(tempDir, "useTerminalOsc.mjs");
writeFileSync(hookPath, transpiled, "utf8");

const { useTerminalOsc } = await import(pathToFileURL(hookPath).href);

const colorQueries = "\x1b]10;?\x1b\\\x1b]11;?\x1b\\";
const piUserMessage = [
  "\x1b]133;A\x07",
  "\x1b[?2026h",
  "\x1b[48;5;59m\r\x1b[K\r\n ",
  "\x1b[38;5;188mPI177-FIX-你好\x1b[K\x1b[m\r\n",
  "\x1b]133;B\x07",
  "\x1b]133;C\x07",
  "\x1b[?2026l",
].join("");

const normalizeAtEverySplit = (input, expected) => {
  for (let split = 0; split <= input.length; split += 1) {
    const osc = useTerminalOsc({
      sessionId: `session-split-${split}`,
      osPlatformRef: { current: "windows" },
    });
    const actual = osc.normalizeTerminalOutput(input.slice(0, split))
      + osc.normalizeTerminalOutput(input.slice(split));
    assert.equal(actual, expected, `split at ${split}`);
  }
};

test("live OSC color queries are removed without frontend PTY writes", () => {
  const osc = useTerminalOsc({
    sessionId: "session-live",
    osPlatformRef: { current: "windows" },
  });

  assert.equal(osc.normalizeTerminalOutput(`${colorQueries}prompt`), "prompt");
});

test("replay OSC color queries are removed by the same safe filter", () => {
  const osc = useTerminalOsc({
    sessionId: "session-replay",
    osPlatformRef: { current: "windows" },
  });

  assert.equal(osc.normalizeTerminalOutput(`${colorQueries}history`), "history");
});

test("Pi OSC 133 user message survives every daemon frame split", () => {
  normalizeAtEverySplit(piUserMessage, piUserMessage);
});

test("color queries are filtered without consuming the following Pi message", () => {
  normalizeAtEverySplit(`${colorQueries}${piUserMessage}`, piUserMessage);
});

test("an interrupted managed OSC fails open before Pi output", () => {
  for (const incomplete of ["\x1b]10;?", "\x1b]133;A", "\x1b]633;C"]) {
    const osc = useTerminalOsc({
      sessionId: "session-interrupted",
      osPlatformRef: { current: "windows" },
    });
    const actual = osc.normalizeTerminalOutput(incomplete)
      + osc.normalizeTerminalOutput(piUserMessage);
    assert.equal(actual, `${incomplete}${piUserMessage}`);
  }
});

test("frontend OSC pipeline does not own color-query replies", () => {
  const oscSource = readFileSync(new URL("../src/features/terminal/hooks/useTerminalOsc.ts", import.meta.url), "utf8");
  const displaySource = readFileSync(new URL("../src/features/terminal/hooks/useTerminalDisplay.ts", import.meta.url), "utf8");
  assert.doesNotMatch(oscSource, /terminalProcessManager\.write/u);
  assert.doesNotMatch(oscSource, /replyToColorQueries/u);
  assert.doesNotMatch(displaySource, /replyToColorQueries/u);
});
