import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Grok history path args use session root then hook config dir", () => {
  const source = readFileSync(new URL("../src/lib/historyPathArgs.ts", import.meta.url), "utf8");
  assert.match(source, /grokSessionRoot:/);
  assert.match(source, /activeHistorySessionRoot\("grok"\)/);
  assert.match(source, /grokSessionRootFromHookDir/);
  assert.match(source, /settings\.grokHookConfigDir/);
});

test("Grok resume uses --resume and validates session IDs", () => {
  const terminal = readFileSync(new URL("../src/stores/terminalStore.ts", import.meta.url), "utf8");
  assert.match(terminal, /grok --resume/);
  assert.match(terminal, /grok --continue/);
  assert.match(terminal, /isValidGrokSessionId/);
  const resume = readFileSync(new URL("../src/lib/historyResumeCommand.ts", import.meta.url), "utf8");
  assert.match(resume, /isValidGrokSessionId/);
});

test("Grok Hook config dir migrates into history session root", () => {
  const source = readFileSync(new URL("../src/stores/historySourceSettingsStore.ts", import.meta.url), "utf8");
  assert.match(source, /instanceFromLegacyPath\("grok"/);
  assert.match(source, /grokHookConfigDir/);
  assert.match(source, /sessionRoot/);
});

test("Grok history capabilities include local delete", () => {
  const source = readFileSync(new URL("../src/lib/historySources.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const grokBlock = source.match(/id: "grok",[\s\S]*?parserPlan: \{[\s\S]*?\n  \},/)?.[0];
  assert.ok(grokBlock, "expected a grok history source descriptor");
  assert.match(grokBlock, /delete: "supported"/);
  assert.match(grokBlock, /resume: "supported"/);
  assert.match(grokBlock, /realtimeStats: "supported"/);
});

test("SSH Grok is a CLI/Hook source and not a remote history source", () => {
  const integration = readFileSync(new URL("../src/lib/sshToolIntegration.ts", import.meta.url), "utf8");
  assert.match(integration, /grok: "\$HOME\/\.grok"/);
  assert.match(integration, /resolveSshHistorySource/);
  const dialog = readFileSync(
    new URL("../src/components/settings/pages/SshCliIntegrationDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(dialog, /"grok"/);
  assert.match(dialog, /Grok Build/);
});
