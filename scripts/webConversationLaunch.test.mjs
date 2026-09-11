import test from "node:test";
import assert from "node:assert/strict";
import { parseWebConversationLaunch } from "../src/shared/lib/webConversationLaunch.ts";

test("keeps quoted Windows launchers and config values intact", () => {
  assert.deepEqual(parseWebConversationLaunch('"C:\\Program Files\\codex.cmd" -m gpt-test -c model_reasoning_effort="high"', "codex"), {
    launcher: "C:\\Program Files\\codex.cmd", launcherArgs: ["-c", "model_reasoning_effort=high"], model: "gpt-test",
  });
});
test("rejects shell composition and wrong executables", () => {
  for (const command of ["codex; whoami", "codex | more", "pwsh -c codex", 'codex "unterminated']) {
    assert.throws(() => parseWebConversationLaunch(command, "codex"));
  }
});
test("preserves Claude argument boundaries and drops only display-specific Codex flag", () => {
  assert.deepEqual(parseWebConversationLaunch("claude --settings 'C:\\My Config\\settings.json'", "claude").launcherArgs,
    ["--settings", "C:\\My Config\\settings.json"]);
  assert.deepEqual(parseWebConversationLaunch("codex --no-alt-screen --model=test", "codex"),
    { launcher: "codex", launcherArgs: [], model: "test" });
});
test("drops terminal resume selectors because the structured request owns session selection", () => {
  assert.deepEqual(
    parseWebConversationLaunch("codex resume 019fc591-8a0b-7872-95b5-49c591ed4db1 -c model=example", "codex"),
    { launcher: "codex", launcherArgs: ["-c", "model=example"], model: undefined },
  );
  assert.deepEqual(
    parseWebConversationLaunch("claude --resume old-session --settings settings.json", "claude"),
    { launcher: "claude", launcherArgs: ["--settings", "settings.json"], model: undefined },
  );
});
