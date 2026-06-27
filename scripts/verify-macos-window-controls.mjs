import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const macosConfig = JSON.parse(await readFile("src-tauri/tauri.macos.conf.json", "utf8"));
const mainWindow = macosConfig?.app?.windows?.[0];

assert.equal(
  mainWindow?.decorations,
  true,
  "macOS config must enable native decorations so the system traffic-light controls are available"
);
assert.equal(
  mainWindow?.titleBarStyle,
  "Visible",
  "macOS config must use a separate native title bar so it cannot intercept webview controls"
);
assert.equal(
  mainWindow?.hiddenTitle,
  true,
  "macOS config must hide the native title text because the app renders its own title"
);
assert.equal(
  mainWindow?.trafficLightPosition,
  undefined,
  "macOS config must not use overlay traffic-light positioning"
);

const titleBarSource = await readFile("src/components/WindowTitleBar.tsx", "utf8");
const appSource = await readFile("src/App.tsx", "utf8");
const sidebarSource = await readFile("src/components/sidebar/index.tsx", "utf8");

assert.match(
  titleBarSource,
  /isMacOs/,
  "WindowTitleBar must detect macOS before deciding whether to render custom controls"
);
assert.match(
  titleBarSource,
  /if \(isMacOs\) return null/,
  "WindowTitleBar must not render custom webview chrome on macOS"
);
assert.match(
  titleBarSource,
  /!isMacOs && IN_TAURI/,
  "WindowTitleBar must not render custom Windows-style controls on macOS"
);
assert.match(
  appSource,
  /if \(!IN_TAURI \|\| isMacOs\) return;/,
  "App must not force window size changes on macOS native window management"
);
assert.match(
  sidebarSource,
  /if \(compactMode \|\| isMacOs\) return;/,
  "Sidebar must not auto-collapse on macOS native split-screen resize"
);

console.log("macOS window controls verification passed");
