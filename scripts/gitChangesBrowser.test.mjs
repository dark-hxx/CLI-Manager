import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { build } from "esbuild";

// 独立临时浏览器配置，不启动 Tauri 或复用用户浏览器；无 Chrome 时明确跳过。
test("real Git tree browser rendering stays bounded at 64887 changes", { timeout: 90000 }, async t => {
  const chrome = process.env.GIT_TEST_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  try { await access(chrome); } catch { t.skip("Set GIT_TEST_CHROME to an installed Chromium executable"); return; }
  const directory = await mkdtemp(join(tmpdir(), "cli-manager-git-browser-"));
  const workspace = process.cwd().replaceAll("\\", "/");
  const mocks = [
    [/shared\/preferences\/settingsStore$/, 'export const useSettingsStore = { getState: () => ({gitGroupBy:"directory"}) };'],
    [/shared\/platform\/debugConsole$/, 'export const debugConsoleWarn = () => {};'],
    [/stats\/api\/termStatsUi$/, 'export const TERM = {fg:"#ddd",bg:"#111",dim:"#888",green:"#0a0",red:"#a00",blue:"#08f",magenta:"#f0f",cyan:"#0ff"}; export const panelColorTint = () => "transparent";'],
    [/terminal\/api\/useTerminalFilePointerDrag$/, 'export const isTerminalFilePointerDragClickHandled = () => false;'],
    [/files\/api\/PathCopyMenu$/, 'export const PathCopyMenu = () => null;'],
    [/shared\/i18n\/index$/, `import {zh} from "${workspace}/src/shared/i18n/messages/git.zh-CN.ts"; import {en} from "${workspace}/src/shared/i18n/messages/git.en-US.ts";
      export const useI18n = () => ({t: key => (window.testLanguage === "en-US" ? en : zh)[key] ?? key});`],
  ];
  const platformMocks = {
    name: "git-browser-platform-fixture",
    setup(builder) {
      builder.onResolve({ filter: /./ }, args => {
        const match = mocks.find(([pattern]) => pattern.test(args.path.replaceAll("\\", "/")));
        if (match) return { path: args.path, namespace: "fixture", pluginData: match[1] };
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.pluginData, loader: "ts", resolveDir: process.cwd() }));
    },
  };
  const common = { bundle: true, format: "esm", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" };
  await build({ ...common, entryPoints: ["scripts/fixtures/gitChangesLargeBrowser.tsx"], outfile: join(directory, "app.js"), plugins: [platformMocks] });
  await build({ ...common, entryPoints: ["src/features/git/lib/gitTreeBuilder.worker.ts"], outfile: join(directory, "gitTreeBuilder.worker.ts") });
  await writeFile(join(directory, "index.html"), '<html><body><div id="root"></div><script>window.addEventListener("error", e => window.fixtureBootError = e.message)</script><script type="module" src="/app.js"></script></body></html>');
  let child;
  let socket;
  const server = createServer(async (request, response) => {
    const name = request.url === "/app.js" ? "app.js" : request.url === "/gitTreeBuilder.worker.ts" ? "gitTreeBuilder.worker.ts" : "index.html";
    response.setHeader("Content-Type", name === "index.html" ? "text/html; charset=utf-8" : "text/javascript");
    response.end(await readFile(join(directory, name)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    socket?.close();
    child?.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // 只删除本次 mkdtemp 得到且已验证仍处于系统临时目录的独立测试产物。
    const target = resolve(directory);
    const prefix = join(resolve(tmpdir()), "cli-manager-git-browser-");
    if (!target.startsWith(prefix)) throw new Error("Unexpected browser fixture path");
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  const profile = join(directory, "profile");
  child = spawn(chrome, ["--headless=new", "--no-first-run", "--disable-gpu", "--disable-background-networking",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", `http://127.0.0.1:${server.address().port}`], { windowsHide: true });
  child.stdout.resume();
  child.stderr.resume();

  // CDP 使用真实时间等待 Worker，不用虚拟时钟提前耗尽后台构造的超时预算。
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(port, "Chromium debugging port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(target => target.type === "page");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let result;
  for (let attempt = 0; attempt < 400 && !result; attempt++) {
    result = await new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser CDP response timed out")), 5000);
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        // 初次导航替换 about:blank 的执行上下文时重试只读探测。
        resolveResult(message.result?.result?.value ?? null);
      };
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { returnByValue: true,
        expression: `window.testResult ?? (window.fixtureBootError ? {failures:[window.fixtureBootError], reports:[]} : null)`,
      } }));
    });
    if (!result) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(result, "Browser fixture completed");
  socket.send(JSON.stringify({ id: 2, method: "Browser.close" }));
  await new Promise(resolve => { child.once("exit", resolve); setTimeout(resolve, 2000); });
  t.diagnostic(JSON.stringify(result.reports));
  assert.deepEqual(result.failures, []);
});
