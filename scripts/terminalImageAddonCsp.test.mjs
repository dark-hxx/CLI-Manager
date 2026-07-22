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

test("Tauri CSP permits WebAssembly without enabling general unsafe eval", () => {
  const csp = tauriConfig.app.security.csp;

  assert.match(csp, /script-src[^;]*'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /(?:^|\s)'unsafe-eval'(?:\s|;|$)/);
});

test("terminal image addon failure falls back without aborting terminal setup", () => {
  assert.match(
    terminalSource,
    /if \(initialWebglReady\) \{\s*try \{\s*terminal\.loadAddon\(imageAddon\);\s*\} catch \(err\) \{[\s\S]*?imageAddon\.dispose\(\);[\s\S]*?logWarn\("Failed to load terminal image addon; continuing without terminal image support"/,
  );
  assert.match(terminalSource, /terminalRef\.current = terminal;/);
});
