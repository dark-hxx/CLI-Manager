import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLinuxGraphicsDiagnostics,
  isLinuxGraphicsConstrained,
  shouldDisableTerminalWebgl,
} from "../src/shared/platform/linuxGraphics.ts";

// 构造 Linux 图形诊断样例并允许覆盖指定字段。
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

// 验证 NVIDIA Wayland 被识别为受限环境但不直接禁用终端 WebGL。
test("NVIDIA Wayland is treated as constrained without disabling terminal WebGL", () => {
  const value = diagnostics();
  assert.equal(isLinuxGraphicsConstrained(value), true);
  assert.equal(shouldDisableTerminalWebgl(value), false);
});

// 验证明确的 WebKit 降级模式禁用终端 WebGL。
test("explicit WebKit fallback modes disable terminal WebGL", () => {
  assert.equal(shouldDisableTerminalWebgl(diagnostics({ effectiveMode: "disable-dmabuf" })), true);
  assert.equal(shouldDisableTerminalWebgl(diagnostics({ effectiveMode: "disable-compositing" })), true);
});

// 验证图形诊断仅输出允许字段而不泄露环境变量。
test("diagnostic text contains only the supported fields", () => {
  const text = formatLinuxGraphicsDiagnostics(diagnostics());
  assert.match(text, /sessionType=wayland/);
  assert.match(text, /effectiveMode=explicit-sync-workaround/);
  assert.doesNotMatch(text, /HOME=|PATH=/);
});
