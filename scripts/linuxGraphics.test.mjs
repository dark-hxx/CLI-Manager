import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLinuxGraphicsDiagnostics,
  isLinuxGraphicsConstrained,
  shouldDisableTerminalWebgl,
} from "../src/shared/platform/linuxGraphics.ts";

function diagnostics(overrides = {}) {
  return {
    platform: "linux",
    sessionType: "wayland",
    currentDesktop: "KDE",
    wayland: true,
    nvidiaProprietary: true,
    requestedMode: "auto",
    effectiveMode: "explicit-sync-workaround",
    source: "default",
    explicitSyncDisabled: true,
    dmabufDisabled: false,
    compositingDisabled: false,
    ...overrides,
  };
}

test("NVIDIA Wayland is treated as constrained without disabling terminal WebGL", () => {
  const value = diagnostics();
  assert.equal(isLinuxGraphicsConstrained(value), true);
  assert.equal(shouldDisableTerminalWebgl(value), false);
});

test("explicit WebKit fallback modes disable terminal WebGL", () => {
  assert.equal(shouldDisableTerminalWebgl(diagnostics({ effectiveMode: "disable-dmabuf" })), true);
  assert.equal(shouldDisableTerminalWebgl(diagnostics({ effectiveMode: "disable-compositing" })), true);
});

test("diagnostic text contains only the supported fields", () => {
  const text = formatLinuxGraphicsDiagnostics(diagnostics());
  assert.match(text, /sessionType=wayland/);
  assert.match(text, /effectiveMode=explicit-sync-workaround/);
  assert.doesNotMatch(text, /HOME=|PATH=/);
});
