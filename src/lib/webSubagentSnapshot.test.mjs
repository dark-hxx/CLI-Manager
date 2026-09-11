import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
const load = async (entry) => {
  const result = await build({ entryPoints: [new URL(entry, import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, "$1:")], bundle: true, write: false, platform: "node", format: "esm" });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
};
const { buildWebSubagentSnapshots } = await load("./webSubagentSnapshot.ts");
const { parseTranscriptLines } = await load("./subagentTranscriptMessages.ts");
const child = (id, parentSessionId = "p1") => ({ id, title: id, kind: "subagent-transcript", subagent: { parentSessionId, source: { kind: "child-jsonl" } } });
const line = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: text } }) + "\n";
const transcript = (content, ended = false) => ({ content, ended, source: { kind: "child-jsonl" } });

test("snapshots include only children of published parents and reflect content, end and removal", () => {
  const children = [child("a"), child("b", "p2"), { id: "p1", title: "Parent", kind: "pty" }];
  let result = buildWebSubagentSnapshots(children, { a: transcript(line("first")) }, new Set(["p1"]));
  assert.equal(result.length, 1); assert.equal(result[0].parentSessionId, "p1");
  assert.equal(parseTranscriptLines(result[0].content, 1).messages[0].text, "first");
  result = buildWebSubagentSnapshots(children, { a: transcript(line("second"), true) }, new Set(["p1"]));
  assert.equal(result[0].ended, true); assert.match(result[0].content, /second/);
  assert.deepEqual(buildWebSubagentSnapshots([], {}, new Set(["p1"])), []);
});

test("snapshot content budget handles large multibyte single messages without losing valid JSONL", () => {
  const children = Array.from({ length: 64 }, (_, index) => child("a" + index));
  const transcripts = Object.fromEntries(children.map(({ id }) => [id, transcript(line("中文🚀".repeat(20000)))]));
  const result = buildWebSubagentSnapshots(children, transcripts, new Set(["p1"]));
  assert.ok(result.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) <= 128 * 1024);
  assert.ok(result.every((item) => item.truncated && Buffer.byteLength(item.content) <= 32 * 1024 && parseTranscriptLines(item.content, 1).messages.length === 1));
});

test("snapshots do not transmit transcript metadata or unsupported raw records", () => {
  const content = JSON.stringify({ type: "session_meta", payload: { cwd: "PRIVATE-PATH" } }) + "\n" + line("visible answer");
  const [result] = buildWebSubagentSnapshots([child("a")], { a: transcript(content) }, new Set(["p1"]));
  assert.doesNotMatch(result.content, /PRIVATE-PATH|session_meta/); assert.match(result.content, /visible answer/);
});

test("shared parser accepts Claude and Codex messages, tool results, bilingual labels and malformed records", () => {
  const content = ["null", "bad-json", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Claude" }] } }), JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex" }] } }), JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "test", arguments: "{}" } }), JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "passed" } })].join("\n");
  const result = parseTranscriptLines(content, 1, { toolCall: "Tool call", toolResult: "Tool result" });
  assert.deepEqual(result.messages.map((item) => item.role), ["assistant", "assistant", "tool", "tool"]);
  assert.match(result.messages[2].text, /Tool call: test/); assert.match(result.messages[3].text, /Tool result: passed/);
});
