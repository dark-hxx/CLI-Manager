// Generate a standalone local renderer fixture; no app or server is started.
import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("./fixtures/statsScreenshot.browser.ts", import.meta.url))],
  bundle: true, write: false, format: "iife", globalName: "statsScreenshotTests", platform: "browser",
});
const target = join(mkdtempSync(join(tmpdir(), "stats-screenshot-browser-")), "index.html");
writeFileSync(target, '<!doctype html><meta charset="utf-8"><title>Statistics capture test</title><script>'
  + outputFiles[0].text.replaceAll("</script", "<\\/script") + '</script>');
console.log(pathToFileURL(target).href);
