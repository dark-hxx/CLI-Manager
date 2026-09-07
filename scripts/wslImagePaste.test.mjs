import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const terminalSource = readFileSync(new URL("../src/components/XTermTerminal.tsx", import.meta.url), "utf8");
const inputSource = readFileSync(new URL("../src/hooks/useTerminalInput.ts", import.meta.url), "utf8");
const toolsSource = readFileSync(new URL("../src/lib/cliTools.ts", import.meta.url), "utf8");
const pathSource = readFileSync(new URL("../src/lib/terminalShellPath.ts", import.meta.url), "utf8");

test("Alt+V uses the host clipboard image bridge", () => {
  assert.match(terminalSource, /e\.altKey[^\n]+e\.key\.toLowerCase\(\) === "v"/u);
  assert.match(terminalSource, /readClipboardImagePasteText\(\)/u);
  assert.match(inputSource, /invoke<[^>]+>[\s\S]*?\("clipboard_attach_image_files"\)/u);
});

test("registered AI tools have explicit image paste capability tiers", () => {
  for (const mode of ['imagePasteMode: "native"', 'imagePasteMode: "at"', 'imagePasteMode: "aider"']) {
    assert.match(toolsSource, new RegExp(mode, "u"));
  }
  assert.match(inputSource, /if \(mode === "unsupported"\) throw new Error\("clipboard_image_tool_unsupported"\)/u);
});

test("Windows attachment paths become WSL mount paths", () => {
  assert.match(pathSource, /normalized === "wsl" \? windowsPathToWsl\(path\) : path/u);
  assert.match(pathSource, /`\/mnt\/\$\{match\[1\]\.toLowerCase\(\)\}/u);
});
