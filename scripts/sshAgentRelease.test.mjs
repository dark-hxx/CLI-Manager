import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-ssh-agent-release-"));
// 进程退出时清理本测试创建的临时转译目录。
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/features/remote/api/sshAgentRelease.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "sshAgentRelease.mjs");
writeFileSync(modulePath, output, "utf8");

const {
  isSshAgentUpgradeAvailable,
  resolveCurrentSshAgentVersion,
  shouldApplySshAgentReleaseResult,
  sshAgentUpgradeNotice,
} = await import(pathToFileURL(modulePath).href);

// 构造 SSH 代理发布动作及版本信息测试样例。
function release(action, version = "0.1.9", currentVersion = "0.1.7") {
  return { action, version, currentVersion };
}

// 验证只有升级动作提示可用更新。
test("只有 upgrade 才显示更新提示", () => {
  assert.equal(isSshAgentUpgradeAvailable(release("upgrade")), true);
  assert.equal(isSshAgentUpgradeAvailable(release("install")), false);
  assert.equal(isSshAgentUpgradeAvailable(release("reinstall")), false);
  assert.equal(isSshAgentUpgradeAvailable(release("downgrade")), false);
  assert.equal(isSshAgentUpgradeAvailable(null), false);
});

// 验证更新提示包含当前版本和可用版本。
test("更新提示带上可用版本和当前版本", () => {
  assert.deepEqual(sshAgentUpgradeNotice(release("upgrade", "0.1.9", "0.1.7")), {
    version: "0.1.9",
    current: "0.1.7",
  });
  assert.equal(sshAgentUpgradeNotice(release("install")), null);
  assert.equal(sshAgentUpgradeNotice(null), null);
});

// 验证当前版本追平可用版本后不再提示更新。
test("当前版本已追平可用版本时不再显示更新", () => {
  assert.equal(sshAgentUpgradeNotice(release("upgrade", "0.1.9", "0.1.7"), "0.1.9"), null);
  assert.equal(sshAgentUpgradeNotice(release("upgrade", "0.1.9", "0.1.7"), "v0.1.9"), null);
  assert.deepEqual(sshAgentUpgradeNotice(release("upgrade", "0.1.9", "0.1.7"), "0.1.8"), {
    version: "0.1.9",
    current: "0.1.8",
  });
});

// 验证未安装或版本为空时不显示升级提示。
test("未安装或当前版本为空时不显示更新", () => {
  assert.equal(sshAgentUpgradeNotice(release("upgrade", "0.1.9", "0.1.7"), ""), null);
  assert.equal(sshAgentUpgradeNotice(release("upgrade", "0.1.9", ""), ""), null);
});

// 验证未安装探测结果不回退到旧安装版本。
test("探测未安装时不回落到旧 installation 版本", () => {
  assert.equal(resolveCurrentSshAgentVersion({ status: "notInstalled", agentVersion: "" }, "0.1.7"), "");
  assert.equal(resolveCurrentSshAgentVersion({ status: "installed", agentVersion: "0.1.8" }, "0.1.7"), "0.1.8");
  assert.equal(resolveCurrentSshAgentVersion(null, "0.1.7"), "0.1.7");
});

// 验证过期的版本检查结果不覆盖最新检查状态。
test("过期的版本检查结果不会被应用", () => {
  assert.equal(shouldApplySshAgentReleaseResult(3, 3), true);
  assert.equal(shouldApplySshAgentReleaseResult(2, 3), false);
});
