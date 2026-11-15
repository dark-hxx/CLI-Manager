import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeCommandPrefix, completionToken, fileRequest, fileItems, skillItems, fileReference, replaceCompletion, DRAFT_LIMIT } from "./completion.ts";

test("native command prefixes allow actual skill namespaces but never controls or arguments", () => {
  for (const prefix of ["/", "/mcp", "/my-skill", "/plugin:skill", "/future_command"]) assert.equal(nativeCommandPrefix(prefix), true);
  for (const prefix of ["", "/mcp\r", "/mcp\n", "/model x", "/../../x", "/foo;bar", "/\x1b", "x /mcp", "/" + "x".repeat(128)]) {
    assert.equal(nativeCommandPrefix(prefix), false, JSON.stringify(prefix));
  }
});

test("completion follows the caret, ignores selections, email, inline slash and ordinary paths", () => {
  for (const input of ["test@example.com", "explain /model", "/src/app.ts", "https://example.com/", "src/", "@a b", "hello\n/model"]) {
    assert.equal(completionToken(input, input.length), null, input);
  }
  assert.equal(completionToken("/mo", 0, 3), null);
  assert.deepEqual(completionToken("/model extra", 3), { kind: "command", start: 0, end: 6, query: "/mo" });
  assert.equal(completionToken("/plugin:skill", 13).query, "/plugin:skill");
  const text = "请看 @src/a.ts 然后解释";
  const caret = text.indexOf("a.ts");
  const token = completionToken(text, caret);
  assert.equal(token.query, "src/");
  assert.equal(text.slice(token.start, token.end), "@src/a.ts");
});

test("file references retain spaces, Unicode and literal quotes while navigating folders", () => {
  for (const path of ["src/入口.ts", "my docs/hello world.md", 'docs/a"b.md']) {
    const value = fileReference(path);
    const queryAt = value.endsWith('"') ? value.length - 1 : value.length;
    const token = completionToken(value, queryAt);
    assert.equal(token.query, path);
    assert.equal(token.end, value.length);
    assert.equal(completionToken(`${value} `, value.length + 1), null);
  }
  const folder = fileReference("my docs", true);
  assert.equal(completionToken(folder, folder.length).query, "my docs/");
  assert.deepEqual(fileRequest(completionToken(folder, folder.length).query), { kind: "file.list", value: "my docs" });
});

test("file requests are bounded and scoped to relative paths", () => {
  assert.deepEqual(fileRequest(""), { kind: "file.list", value: "" });
  assert.deepEqual(fileRequest("src/"), { kind: "file.list", value: "src" });
  assert.deepEqual(fileRequest("src/app"), { kind: "file.search", value: "src/app" });
  for (const value of ["../secret", "src/../", "/etc", "C:/", "src\\foo", ".git/", "a\n", "a".repeat(513)]) {
    assert.equal(fileRequest(value), null, value);
  }
});

test("pasted control characters and incomplete quoted escapes never crash token parsing", () => {
  for (const raw of ['@"a\tb', '@"a\u0000b', '@"a\u001bb', '@"a\\', '@"a\\q']) {
    assert.equal(completionToken(raw, raw.length), null);
  }
});

test("file list excludes unsafe and git entries, sorts folders first and caps results", () => {
  const values = [
    { name: "code.ts", path: "src/code.ts", kind: "file" },
    { name: "src", path: "src", kind: "directory" },
    { name: ".git", path: ".git", kind: "file" }, // Worktree .git is a file.
    { name: ".git", path: ".git", kind: "directory" },
    { name: "secret", path: "../secret", kind: "file" },
    { name: "out", path: "/etc/out", kind: "file" },
    { name: "bad", path: "a\rb", kind: "file" },
    { name: "duplicate", path: "src/code.ts", kind: "file" },
  ];
  assert.deepEqual(fileItems(values).items.map((item) => item.value), ["src", "src/code.ts"]);
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `f${i}`, path: `f${i}`, kind: "file" }));
  assert.equal(fileItems(many).items.length, 80);
  assert.equal(fileItems(many).limited, true);
  assert.throws(() => fileItems({ entries: [] }));
});

test("candidate replacement preserves surrounding draft and enforces its existing limit", () => {
  const text = "before @old.txt after";
  const token = completionToken(text, 9);
  assert.equal(replaceCompletion(text, token, fileReference("my docs/文件.md")).text, 'before @"my docs/文件.md" after');
  assert.equal(replaceCompletion("/mo", completionToken("/mo", 3), "/model").text, "/model ");
  const long = "a".repeat(DRAFT_LIMIT - 2) + " @";
  assert.equal(replaceCompletion(long, completionToken(long, long.length), "@hello"), null);
});

test("Skill candidates filter host policy, preserve namespaces and insert native invocation syntax", () => {
  const skills = [
    { name: "my-skill", state: "available", description: "说明" },
    { name: "plugin:review", state: "available" },
    ...["disabled", "denied", "shadowed", "invalid"].map((state) => ({ name: state, state })),
    ...["../escape", "bad\rname", "$injection", "/model", "x".repeat(129)].map((name) => ({ name, state: "available" })),
  ];
  for (const source of ["claude", "codex"]) {
    const result = skillItems({ available: true, source, skills }, source, "/");
    assert.deepEqual(result.items.map((item) => item.label), ["/my-skill", "/plugin:review"]);
    assert.equal(result.items[0].value, source === "codex" ? "$my-skill" : "/my-skill");
    assert.equal(skillItems({ available: true, source, skills }, source, "/REVIEW").items[0].id, "plugin:review");
    assert.equal(skillItems({ available: true, source, skills }, source, "/model").items.length, 0);
  }
  assert.throws(() => skillItems({ available: true, source: "claude", skills }, "codex", "/"));
  assert.throws(() => skillItems([], "codex", "/"));
  const many = Array.from({ length: 100 }, (_, index) => ({ name: `skill-${index}`, state: "available" }));
  assert.equal(skillItems({ available: true, source: "codex", skills: many }, "codex", "/").items.length, 80);
  assert.equal(skillItems({ available: true, source: "codex", skills: many }, "codex", "/").limited, true);
});
