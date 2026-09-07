import test from "node:test";
import assert from "node:assert/strict";
import { resolveManualDirectCodexEnterData } from "../src/features/terminal/lib/codexManualInput.ts";

test("does not override manual direct codex enter on Windows", () => {
  assert.equal(resolveManualDirectCodexEnterData({
    data: "\r",
    inputBuffer: "codex",
    os: "windows",
  }), null);
});

test("does not override manual direct codex enter on Linux", () => {
  assert.equal(resolveManualDirectCodexEnterData({
    data: "\r",
    inputBuffer: "codex",
    os: "linux",
  }), null);
});

test("does not override manual direct codex enter on macOS", () => {
  assert.equal(resolveManualDirectCodexEnterData({
    data: "\r",
    inputBuffer: "codex --help",
    os: "macos",
  }), null);
});

test("ignores non-direct commands even on macOS", () => {
  assert.equal(resolveManualDirectCodexEnterData({
    data: "\r",
    inputBuffer: "echo codex",
    os: "macos",
  }), null);
});
