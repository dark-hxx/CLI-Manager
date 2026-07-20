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
`);
writeFileSync(join(tempDir, "terminalOscParse.mjs"), `
export const LEGACY_RUNTIME_OSC_PREFIX = "\\x1b]777;cli-manager;";
export const OSC_PREFIX = "\\x1b]";
export function findOscTerminator(text, from) {
  for (let index = from; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 7) return { index, length: 1 };
    if (text.charCodeAt(index) === 27 && text[index + 1] === "\\\\") return { index, length: 2 };
  }
  return null;
}
export function matchIntegrationOscPrefix() { return { kind: "none" }; }
export function parseSpecialColorQuery(body) {
  if (body === "10;?") return 10;
  if (body === "11;?") return 11;
  return null;
}
export function parseStandardIntegrationCwd() { return null; }
`);
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
const source = readFileSync(new URL("../src/hooks/useTerminalOsc.ts", import.meta.url), "utf8");
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
  .replace('from "../stores/terminalStore"', 'from "./terminalStore.mjs"');
const hookPath = join(tempDir, "useTerminalOsc.mjs");
writeFileSync(hookPath, transpiled, "utf8");

const { useTerminalOsc } = await import(pathToFileURL(hookPath).href);

const colorQueries = "\x1b]10;?\x1b\\\x1b]11;?\x1b\\";

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

test("frontend OSC pipeline does not own color-query replies", () => {
  const oscSource = readFileSync(new URL("../src/hooks/useTerminalOsc.ts", import.meta.url), "utf8");
  const displaySource = readFileSync(new URL("../src/hooks/useTerminalDisplay.ts", import.meta.url), "utf8");
  assert.doesNotMatch(oscSource, /terminalProcessManager\.write/u);
  assert.doesNotMatch(oscSource, /replyToColorQueries/u);
  assert.doesNotMatch(displaySource, /replyToColorQueries/u);
});
