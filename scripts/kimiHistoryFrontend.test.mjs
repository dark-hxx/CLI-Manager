import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Kimi history path args prefer history source root then hook config dir", () => {
  const source = readFileSync(new URL("../src/lib/historyPathArgs.ts", import.meta.url), "utf8");
  assert.match(source, /kimiConfigDir:/);
  assert.match(source, /activeHistoryConfigRoot\("kimi"\)/);
  assert.match(source, /settings\.kimiHookConfigDir/);
});

test("Kimi realtime stats infer the history source from the kimi command", () => {
  const source = readFileSync(new URL("../src/components/terminal/TerminalStatsPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /\\bkimi\\b/);
});

test("Kimi resume kind uses --session and never injects KIMI_CODE_HOME in local history args", () => {
  const terminal = readFileSync(new URL("../src/stores/terminalStore.ts", import.meta.url), "utf8");
  assert.match(terminal, /KIMI_COMMAND_PATTERN/);
  assert.match(terminal, /kimi --session/);
  assert.match(terminal, /kimi --continue/);
  const pathArgs = readFileSync(new URL("../src/lib/historyPathArgs.ts", import.meta.url), "utf8");
  assert.doesNotMatch(pathArgs, /KIMI_CODE_HOME/);
});
