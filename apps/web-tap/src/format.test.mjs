import assert from "node:assert/strict";
import { test } from "node:test";
import { clock, duration, fullTime, readerLines, splitPath } from "./format.ts";

test("footer times are 24-hour and dated when not today", () => {
  const now = new Date(2026, 9, 16, 22, 0);
  assert.equal(clock(new Date(2026, 9, 16, 9, 5).toISOString(), now), "09:05");
  assert.equal(clock(new Date(2026, 9, 15, 23, 40).toISOString(), now), "10/15 23:40");
  assert.equal(clock("not a date", now), "");
  assert.equal(duration(41_000), "41s");
  assert.equal(duration(137_000), "2m 17s");
  assert.equal(fullTime(new Date(2026, 9, 16, 9, 5, 7).getTime()), "2026-10-16 09:05:07");
  assert.equal(fullTime("not a date"), "");
  assert.deepEqual(splitPath("apps/web-tap/src/App.tsx"), { dir: "apps/web-tap/src", name: "App.tsx" });
});

test("reading view clips drawn rules and trims padded box borders", () => {
  const [top, body, plain] = readerLines(["╭──────────╮", "│ Welcome to Claude Code!        │", "plain text"]);
  assert.deepEqual(top, { text: "╭──────────╮", rule: true });
  assert.deepEqual(body, { text: "│ Welcome to Claude Code!", rule: false });
  assert.deepEqual(plain, { text: "plain text", rule: false });
});
