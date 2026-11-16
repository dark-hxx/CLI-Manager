import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");
const build = workflow.split(/(?=^  [\w-]+:\n)/m)
  .find((job) => job.startsWith("  build:\n"));
assert.ok(build, "release must contain the desktop build job");
const steps = build.split(/(?=^      - )/m).slice(1);

// 从真实工作流定位资源生产者与 Cargo 消费者，缺少步骤时直接报告前置条件缺失。
function stepIndex(pattern, description) {
  const index = steps.findIndex((step) => pattern.test(step));
  assert.notEqual(index, -1, description);
  return index;
}

const web = stepIndex(/run: npm run web:build\b/, "web assets must be built before direct Cargo checks");
const agent = stepIndex(/name: Download bundled SSH Agent\b/, "signed Agent assets must be downloaded");
const verifyAgent = stepIndex(/name: Verify bundled SSH Agent files\b/, "downloaded Agent assets must be verified");
const proxy = stepIndex(/run: npm run test:codex-proxy:e2e\b/, "the real Windows proxy test must remain enabled");
const devProxy = stepIndex(/run: npm run test:tauri-dev-proxy\b/, "the Windows dev proxy test must remain enabled");
const bundle = stepIndex(/uses: tauri-apps\/tauri-action@/, "the signed Tauri build must remain enabled");
const portableTest = stepIndex(/run: node --test scripts\/package-portable\.test\.mjs\b/, "Windows portable packaging must have a real regression test");
const portable = stepIndex(/name: Package Windows portable ZIP\b/, "the real Windows portable ZIP must be packaged");

assert.ok(portableTest < bundle, "portable regression must gate the expensive signed build");
assert.ok(bundle < portable, "package portable binaries after the Tauri build");
assert.match(steps[portableTest], /if: matrix\.platform == 'windows-latest'/);
assert.match(steps[portable], /if: matrix\.platform == 'windows-latest'/);
assert.doesNotMatch(steps[portableTest], /continue-on-error:\s*true/);

assert.ok(agent < verifyAgent, "verify Agent assets after download");
for (const consumer of [proxy, devProxy]) {
  assert.ok(web < consumer, "direct Cargo checks require generated web assets");
  assert.ok(verifyAgent < consumer, "direct Cargo checks require verified bundle resources");
  assert.ok(consumer < bundle, "Windows checks must gate signed packaging");
  assert.match(steps[consumer], /if: matrix\.platform == 'windows-latest'/);
}
assert.match(steps[web], /if: matrix\.platform == 'windows-latest'/);
assert.doesNotMatch(
  [web, agent, verifyAgent, proxy, devProxy].map((index) => steps[index]).join("\n"),
  /continue-on-error:\s*true/,
  "resource preparation and Windows checks must fail the release on error",
);
assert.match(workflow, /node \.github\/scripts\/release-workflow\.test\.mjs/);

// Linux 构建矩阵：新增 runner 时依赖安装必须同样生效，且只能产出 deb（AppImage / rpm 已停止发布）。
const linuxDeps = stepIndex(/name: Install Linux dependencies\b/, "Linux bundle dependencies must be installed");
assert.match(steps[linuxDeps], /if: startsWith\(matrix\.platform, 'ubuntu'\)/);
assert.match(build, /- platform: ubuntu-22\.04-arm\b/, "Linux arm64 must be built on an arm runner");
for (const entry of build.matchAll(/- platform: (ubuntu-[\w.-]+)\n\s+args: "([^"]*)"/g)) {
  assert.match(entry[2], /--bundles deb/, `${entry[1]} must bundle deb only`);
}
console.log("release workflow resource prerequisites: checks passed");
