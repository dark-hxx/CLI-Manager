import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tauriConfig = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const terminalSource = readFileSync(
  new URL("../src/components/XTermTerminal.tsx", import.meta.url),
  "utf8",
);
const supportSource = readFileSync(
  new URL("../src/lib/terminalImageAddonSupport.ts", import.meta.url),
  "utf8",
);

test("Tauri CSP permits WebAssembly without enabling general unsafe eval", () => {
  const csp = tauriConfig.app.security.csp;

  assert.match(csp, /script-src[^;]*'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /(?:^|\s)'unsafe-eval'(?:\s|;|$)/);
});

test("terminal image addon probes the actual WebAssembly CSP gate before loading", () => {
  assert.match(supportSource, /new WebAssembly\.Module\(MINIMAL_WASM_MODULE\)/);
  assert.match(supportSource, /catch \{\s*cachedWasmSupport = false;/);
  assert.match(terminalSource, /if \(!canUseTerminalImageAddonWasm\(\)\) \{/);
  assert.match(
    terminalSource,
    /if \(initialWebglReady\) \{[\s\S]*?if \(!canUseTerminalImageAddonWasm\(\)\) \{[\s\S]*?\} else \{[\s\S]*?terminal\.loadAddon\(imageAddon\);/,
  );
  assert.match(terminalSource, /terminalRef\.current = terminal;/);
});
