import test from "node:test";
import assert from "node:assert/strict";
import { applyTerminalAppearance, terminalAppearanceOptions } from "../src/features/terminal/lib/terminalAppearance.ts";

test("terminal appearance defaults and clamps match the shared native preference contract", () => {
  assert.deepEqual(terminalAppearanceOptions(undefined, undefined), { lineHeight: 1, cursorStyle: "bar" });
  assert.deepEqual(terminalAppearanceOptions(0, "block"), { lineHeight: 1, cursorStyle: "block" });
  assert.deepEqual(terminalAppearanceOptions(3, "underline"), { lineHeight: 2, cursorStyle: "underline" });
  assert.deepEqual(terminalAppearanceOptions(NaN, "hidden"), { lineHeight: 1, cursorStyle: "bar" });
});

test("line height requests a refit but cursor-only changes preserve terminal geometry", () => {
  const terminal = { options: { lineHeight: 1, cursorStyle: "bar", fontFamily: "Existing Mono" } };
  assert.equal(applyTerminalAppearance(terminal, 1.4, "block"), true);
  assert.equal(terminal.options.lineHeight, 1.4);
  assert.equal(terminal.options.cursorStyle, "block");
  assert.equal(applyTerminalAppearance(terminal, 1.4, "underline"), false);
  assert.equal(terminal.options.cursorStyle, "underline");
  assert.equal(terminal.options.fontFamily, "Existing Mono");
});
