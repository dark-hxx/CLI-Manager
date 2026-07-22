import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const macosConfig = JSON.parse(await readFile("src-tauri/tauri.macos.conf.json", "utf8"));
const cargoManifest = await readFile("src-tauri/Cargo.toml", "utf8");
const macosWindows = macosConfig?.app?.windows ?? [];
const mainWindow = macosWindows.find((window) => window.label === "main");
const desktopPetWindow = macosWindows.find((window) => window.label === "desktop-pet");

assert.equal(
  macosConfig?.app?.macOSPrivateApi,
  true,
  "macOS config must enable the private API required for transparent Tauri windows"
);
assert.match(
  cargoManifest,
  /tauri\s*=\s*\{[^\n]*features\s*=\s*\[[^\]]*"macos-private-api"/,
  "Cargo must enable Tauri's macos-private-api feature for transparent windows"
);
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
assert.ok(
  desktopPetWindow,
  "macOS config must preserve the desktop-pet window when replacing the base windows array"
);
assert.equal(
  desktopPetWindow?.visibleOnAllWorkspaces,
  true,
  "macOS desktop pet must remain visible across Spaces"
);
assert.equal(
  desktopPetWindow?.transparent,
  true,
  "macOS desktop pet window must keep its transparent background"
);

const titleBarSource = await readFile("src/components/WindowTitleBar.tsx", "utf8");
const appSource = await readFile("src/App.tsx", "utf8");
const sidebarSource = await readFile("src/components/sidebar/index.tsx", "utf8");
const desktopPetCommandSource = await readFile(
  "src-tauri/src/commands/desktop_pet.rs",
  "utf8"
);

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
assert.match(
  desktopPetCommandSource,
  /desktop_pet_window_reset_position[\s\S]*?return Err\("pet_window_missing"\.to_string\(\)\);/,
  "Desktop pet position reset must report a missing native window instead of showing false success"
);

console.log("macOS window controls verification passed");
