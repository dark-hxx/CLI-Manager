import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-osc52-e2e-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));
writeFileSync(join(tempDir, "react.mjs"), `export function useRef(value) { return { current: value }; }`);
writeFileSync(join(tempDir, "terminalOscPath.mjs"), `
export function parseOsc7Cwd() { return null; }
export function decodeOscPathValue(value) { return value; }
`);
writeFileSync(join(tempDir, "terminalColor.mjs"), `
export function normalizeHexColor(value, fallback) { return value || fallback; }
`);
const parseSource = readFileSync(new URL("../src/lib/terminalOscParse.ts", import.meta.url), "utf8");
writeFileSync(join(tempDir, "terminalOscParse.mjs"), ts.transpileModule(parseSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  fileName: "terminalOscParse.ts",
}).outputText
  .replace('from "./terminalOscPath"', 'from "./terminalOscPath.mjs"')
  .replace('from "./terminalColor"', 'from "./terminalColor.mjs"'));
writeFileSync(join(tempDir, "terminalStore.mjs"), `
export const useTerminalStore = { getState() { return { sessions: [], handleShellRuntimeEvent() {}, updateSessionCwd() {} }; } };
`);
const hookSource = readFileSync(new URL("../src/hooks/useTerminalOsc.ts", import.meta.url), "utf8");
writeFileSync(join(tempDir, "useTerminalOsc.mjs"), ts.transpileModule(hookSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  fileName: "useTerminalOsc.ts",
}).outputText
  .replace('from "react"', 'from "./react.mjs"')
  .replace('from "../lib/terminalOscPath"', 'from "./terminalOscPath.mjs"')
  .replace('from "../lib/terminalOscParse"', 'from "./terminalOscParse.mjs"')
  .replace('from "../stores/terminalStore"', 'from "./terminalStore.mjs"'));
const { useTerminalOsc } = await import(pathToFileURL(join(tempDir, "useTerminalOsc.mjs")).href);
const copied = [];
const osc = useTerminalOsc({
  sessionId: "session-e2e",
  osPlatformRef: { current: "linux" },
  onOsc52Write: (text) => copied.push(text),
});
const visible = osc.normalizeTerminalOutput(process.argv[2] ?? "", {
  applyOsc52: process.env.APPLY_OSC52 !== "false",
});

process.stdout.write(JSON.stringify({ visible, copied }));
