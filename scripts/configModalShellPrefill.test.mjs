import test from "node:test";
import assert from "node:assert/strict";
import * as shell from "../src/lib/configModalShellPrefill.ts";

test("macOS create modal prefills zsh when shell is blank", () => {
  assert.equal(typeof shell.getConfigModalShellPrefill, "function");
  assert.equal(shell.getConfigModalShellPrefill?.("macos", "", false, false), "zsh");
});

test("non-macOS create modal keeps placeholder selection", () => {
  assert.equal(typeof shell.getConfigModalShellPrefill, "function");
  assert.equal(shell.getConfigModalShellPrefill?.("windows", "", false, false), "");
  assert.equal(shell.getConfigModalShellPrefill?.("linux", "", false, false), "");
});

test("edit and clone flows do not overwrite an empty shell value", () => {
  assert.equal(typeof shell.getConfigModalShellPrefill, "function");
  assert.equal(shell.getConfigModalShellPrefill?.("macos", "", true, false), "");
  assert.equal(shell.getConfigModalShellPrefill?.("macos", "", false, true), "");
});
