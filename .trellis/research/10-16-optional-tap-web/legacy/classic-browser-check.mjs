// Run the existing classic smoke harness without changing its assertions.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.TAP_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, executablePath: process.env.TAP_CHROMIUM,
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  let pickerOpened = false;
  page.on("filechooser", () => { pickerOpened = true; });
  await page.goto(process.env.TAP_CLASSIC_SMOKE_URL || "http://127.0.0.1:5174/");
  const deadline = Date.now() + 100_000;
  let result;
  while (Date.now() < deadline) {
    result = await page.evaluate(() => window.terminalSmoke);
    if (result?.mobileViewportRequested && !result.mobileViewportReady) {
      await page.setViewportSize({ width: 390, height: 700 });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await page.evaluate(() => { window.terminalSmoke.mobileViewportReady = true; });
    }
    if (result?.pickerRequest && !result.pickerChecked) {
      await page.mouse.click(result.pickerRequest.x, result.pickerRequest.y);
      await page.waitForTimeout(100);
      await page.evaluate((opened) => Object.assign(window.terminalSmoke,
        { pickerChecked: true, pickerOpened: opened }), pickerOpened);
    }
    if (result && result.status !== "running" && (result.status === "failed" || result.visualReady)) break;
    await page.waitForTimeout(100);
  }
  assert.equal(result?.status, "passed", JSON.stringify(result));
  console.log(JSON.stringify({ result: result.status, rounds: result.rounds.length,
    imagePipeline: result.imagePipeline, workspacePush: result.workspacePush,
    highFrequency: result.highFrequency, pickerOpened }));
} finally { await browser.close(); }
