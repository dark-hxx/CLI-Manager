import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const terminalSource = readFileSync(new URL("../src/features/terminal/hooks/useXTermController.ts", import.meta.url), "utf8");
const inputSource = readFileSync(new URL("../src/features/terminal/hooks/useTerminalInput.ts", import.meta.url), "utf8");
const toolsSource = readFileSync(new URL("../src/shared/lib/cliTools.ts", import.meta.url), "utf8");
const pathSource = readFileSync(new URL("../src/features/terminal/lib/terminalShellPath.ts", import.meta.url), "utf8");

// 验证 Alt+V 通过宿主剪贴板图片 IPC 获取附件。
test("Alt+V uses the host clipboard image bridge", () => {
  assert.match(terminalSource, /e\.altKey[^\n]+e\.key\.toLowerCase\(\) === "v"/u);
  assert.match(terminalSource, /readClipboardImagePasteText\(\)/u);
  assert.match(inputSource, /invoke<[^>]+>[\s\S]*?\("clipboard_attach_image_files"\)/u);
});

// 验证 AI 工具声明图片粘贴能力，不支持时明确报错。
test("registered AI tools have explicit image paste capability tiers", () => {
  for (const mode of ['imagePasteMode: "native"', 'imagePasteMode: "at"', 'imagePasteMode: "aider"']) {
    assert.match(toolsSource, new RegExp(mode, "u"));
  }
  assert.match(inputSource, /if \(mode === "unsupported"\) throw new Error\("clipboard_image_tool_unsupported"\)/u);
});

// 验证 Windows 附件路径在 WSL 环境转为挂载路径。
test("Windows attachment paths become WSL mount paths", () => {
  assert.match(pathSource, /normalized === "wsl" \? windowsPathToWsl\(path\) : path/u);
  assert.match(pathSource, /`\/mnt\/\$\{match\[1\]\.toLowerCase\(\)\}/u);
});
