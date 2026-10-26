// First run the isolated Rust live_transcript tests with TAP_TRANSCRIPT_FIXTURE=<output>.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { terminalTranscriptPage } from "../src/features/terminal/lib/webTerminalTranscript.ts";
const file = process.argv[2];
if (!file) throw Error("Usage: node scripts/verifyTapTranscriptProjection.mjs <Rust fixture JSON>");
const fixtures = JSON.parse(readFileSync(file, "utf8"));
for (const fixture of fixtures) {
  const { page, canonical, detailed } = fixture;
  const messages = canonical.map((message) => ({ ...message, parts: message.parts?.map((part) => ({
    ...part, tool_name: part.toolName, call_id: part.callId,
  })) }));
  const expected = terminalTranscriptPage({ id: "pty", cliSessionId: page.cliSessionId }, { session_id: page.cliSessionId, messages }, undefined, detailed);
  for (const key of ["available", "start", "total", "messages"]) {
    assert.deepEqual(JSON.parse(JSON.stringify(page[key])), JSON.parse(JSON.stringify(expected[key])), key);
  }
}
console.log(`Canonical Rust → bounded IPC → original TS projection: ${fixtures.length} differential cases passed`);
