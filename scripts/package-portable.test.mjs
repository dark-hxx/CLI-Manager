import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageScript = fileURLToPath(new URL("./package-portable.ps1", import.meta.url));
const windows = process.platform === "win32";
const powershell = process.env.CLI_MANAGER_PORTABLE_TEST_POWERSHELL || "pwsh";
const executables = [
  "cli-manager.exe",
  "cli-manager-codex-proxy.exe",
  "cli-manager-daemon.exe",
  "cli-manager-web-daemon.exe",
];
const resourceFiles = {
  "conpty/README.md": "ConPTY fixture",
  "conpty/x64/conpty.dll": "ConPTY binary fixture",
  "ssh-agent/ssh-agent-release-manifest.json": '{"version":"fixture"}',
  "ssh-agent/install-ssh-agent.sh": "#!/bin/sh\n",
};
const webFiles = {
  "index.html": "Classic Web fixture",
  "assets/classic.js": "Classic JavaScript fixture",
  "assets/nested/classic.css": "Classic nested CSS fixture",
  "tap/index.html": "Tap fixture",
  "tap/assets/tap.js": "Tap JavaScript fixture",
  "tap/assets/chunks/lazy.js": "Tap nested JavaScript fixture",
  "tap/fonts/mono.woff2": "Tap font fixture",
};

// 只在独立临时仓库内准备输入，并在删除前确认目录仍位于本测试的明确前缀。
function fixture(t, { source = "src-tauri/target/release", resources = "src-tauri/resources", web = "apps/web/dist" } = {}) {
  // runner 的临时目录可带小写盘符，PowerShell 会规范化盘符大小写。
  const temporaryPrefix = path.join(os.tmpdir(), "cli-manager-portable-")
    .replace(/^[A-Z]:/, drive => drive.toLowerCase());
  const root = mkdtempSync(temporaryPrefix);
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(temporaryPrefix));
    rmSync(root, { recursive: true, force: true });
  });
  const script = path.join(root, "scripts/package-portable.ps1");
  mkdirSync(path.dirname(script), { recursive: true });
  copyFileSync(packageScript, script);
  const sourceDir = path.join(root, source);
  const resourcesDir = path.join(root, resources);
  const webDir = path.join(root, web);
  const expected = { "CLI-Manager/portable.flag": "" };
  for (const name of executables) {
    const content = `Binary fixture: ${name}`;
    writeFile(path.join(sourceDir, name), content);
    expected[`CLI-Manager/${name}`] = content;
  }
  for (const [name, content] of Object.entries(resourceFiles)) {
    writeFile(path.join(resourcesDir, name), content);
    expected[`CLI-Manager/resources/${name}`] = content;
  }
  for (const [name, content] of Object.entries(webFiles)) {
    writeFile(path.join(webDir, name), content);
    expected[`CLI-Manager/apps/web/dist/${name}`] = content;
  }
  return { root, script, sourceDir, resourcesDir, webDir, expected };
}

// 生成真实磁盘输入，包含多级路径，以便检查递归复制和 ZIP 内容。
function writeFile(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// 从无关工作目录调用实际 PowerShell 入口，不模拟打包实现。
function runPackage(input, args = [], version = "V1.5.1") {
  return spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", input.script, "-Version", version, ...args,
  ], { cwd: os.tmpdir(), encoding: "utf8", timeout: 30_000 });
}

// 用 .NET ZIP API 读取每个实际文件的原始字节，兼容 PowerShell 的路径分隔符。
function archiveFiles(archive) {
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($env:CLI_MANAGER_PORTABLE_TEST_ARCHIVE)
    try {
      $files = @{}
      foreach ($entry in $archive.Entries) {
        if (-not $entry.Name) { continue }
        $stream = $entry.Open()
        $bytes = New-Object System.IO.MemoryStream
        try {
          $stream.CopyTo($bytes)
          $files[$entry.FullName.Replace([char]92, [char]47)] = [Convert]::ToBase64String($bytes.ToArray())
        } finally { $stream.Dispose(); $bytes.Dispose() }
      }
      ConvertTo-Json -InputObject $files -Compress
    } finally { $archive.Dispose() }
  `], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, CLI_MANAGER_PORTABLE_TEST_ARCHIVE: archive },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return Object.fromEntries(Object.entries(JSON.parse(result.stdout.trim()))
    .map(([name, content]) => [name, Buffer.from(content, "base64").toString("utf8")]));
}

test("fresh release binaries package the built Classic/Tap and source resources", { skip: !windows }, (t) => {
  const input = fixture(t);
  assert.equal(existsSync(path.join(input.sourceDir, "apps/web/dist")), false);
  assert.equal(existsSync(path.join(input.sourceDir, "resources")), false);
  const result = runPackage(input);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const archive = path.join(input.root, "dist/portable/CLI-Manager-V1.5.1-Windows-x64-portable.zip");
  assert.deepEqual(archiveFiles(archive), input.expected);
  assert.equal(realpathSync.native(result.stdout.trim()).toLowerCase(), realpathSync.native(archive).toLowerCase());
});

test("Windows 8.3 and long output paths identify the same portable archive", { skip: !windows }, (t) => {
  const input = fixture(t);
  const alias = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:CLI_MANAGER_PORTABLE_TEST_ROOT).ShortPath",
  ], { encoding: "utf8", env: { ...process.env, CLI_MANAGER_PORTABLE_TEST_ROOT: input.root } });
  assert.equal(alias.status, 0, alias.error?.message ?? alias.stderr);
  const shortRoot = alias.stdout.trim();
  if (path.normalize(shortRoot).toLowerCase() === realpathSync.native(input.root).toLowerCase()) {
    t.skip("8.3 directory aliases are disabled on this volume");
    return;
  }
  const result = runPackage({ ...input, script: path.join(shortRoot, "scripts/package-portable.ps1") });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const archive = path.join(shortRoot, "dist/portable/CLI-Manager-V1.5.1-Windows-x64-portable.zip");
  assert.deepEqual(archiveFiles(archive), input.expected);
  // 文本路径确实不同；两者必须由文件系统解析到同一个真实 ZIP。
  assert.notEqual(path.normalize(result.stdout.trim()).toLowerCase(), path.normalize(archive).toLowerCase());
  assert.equal(realpathSync.native(result.stdout.trim()).toLowerCase(), realpathSync.native(archive).toLowerCase());
});

test("stale Cargo resource copies are ignored and repeated packaging replaces old output", { skip: !windows }, (t) => {
  const input = fixture(t);
  writeFile(path.join(input.sourceDir, "apps/web/dist/index.html"), "stale Web");
  writeFile(path.join(input.sourceDir, "resources/stale.txt"), "stale resources");
  const output = path.join(input.root, "dist/portable");
  writeFile(path.join(output, "CLI-Manager/stale.txt"), "old staging");
  for (let pass = 0; pass < 2; pass += 1) {
    const result = runPackage(input, [], "v1.5.1");
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    const archive = path.join(output, "CLI-Manager-V1.5.1-Windows-x64-portable.zip");
    assert.deepEqual(archiveFiles(archive), input.expected);
  }
  assert.equal(existsSync(path.join(output, "CLI-Manager/stale.txt")), false);
});

test("relative and absolute custom input/output paths with spaces survive", { skip: !windows }, (t) => {
  const input = fixture(t, {
    source: "custom build/release", resources: "custom resources", web: "custom web/dist",
  });
  const output = path.join(input.root, "custom output");
  const result = runPackage(input, [
    "-SourceDir", "custom build/release", "-ResourcesDir", input.resourcesDir,
    "-WebDistDir", "custom web/dist", "-OutputDir", output,
  ], "1.5.1-beta.1");
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const archive = path.join(output, "CLI-Manager-V1.5.1-beta.1-Windows-x64-portable.zip");
  assert.deepEqual(archiveFiles(archive), input.expected);
});

test("a custom binary directory still uses the default resource producers", { skip: !windows }, (t) => {
  const input = fixture(t, { source: "another build/release" });
  const result = runPackage(input, ["-SourceDir", input.sourceDir, "-OutputDir", "another output"]);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const archive = path.join(input.root, "another output/CLI-Manager-V1.5.1-Windows-x64-portable.zip");
  assert.deepEqual(archiveFiles(archive), input.expected);
});

const missingInputs = [
  ...executables.map((name) => [name, "sourceDir", name]),
  ["resources", "resourcesDir", ""],
  ["Classic HTML", "webDir", "index.html"],
  ["Classic assets", "webDir", "assets"],
  ["Tap HTML", "webDir", "tap/index.html"],
  ["Tap assets", "webDir", "tap/assets"],
];
for (const [description, directory, relative] of missingInputs) {
  test(`missing ${description} fails before existing output is touched`, { skip: !windows }, (t) => {
    const input = fixture(t);
    const missing = path.join(input[directory], relative);
    assert.ok(missing.startsWith(input.root + path.sep));
    rmSync(missing, { recursive: true, force: true });
    const output = path.join(input.root, "dist/portable");
    const oldArchive = path.join(output, "CLI-Manager-V1.5.1-Windows-x64-portable.zip");
    const oldStaging = path.join(output, "CLI-Manager/keep.txt");
    writeFile(oldArchive, "previous ZIP");
    writeFile(oldStaging, "previous staging");
    const result = runPackage(input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing portable package input/);
    assert.equal(readFileSync(oldArchive, "utf8"), "previous ZIP");
    assert.equal(readFileSync(oldStaging, "utf8"), "previous staging");
  });
}

test("an explicit missing Web source never falls back to default assets", { skip: !windows }, (t) => {
  const input = fixture(t);
  const result = runPackage(input, ["-WebDistDir", "missing web"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing portable package input/);
  assert.equal(existsSync(path.join(input.root, "dist/portable")), false);
});

test("invalid version fails without creating output", { skip: !windows }, (t) => {
  const input = fixture(t);
  const result = runPackage(input, [], "../1.5.1");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid release version/);
  assert.equal(existsSync(path.join(input.root, "dist/portable")), false);
});
