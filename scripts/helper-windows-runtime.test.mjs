import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("helper build selects a working MSVC runtime despite a shadow msvcrt library", {
  skip: process.platform !== "win32",
  timeout: 180_000,
}, (t) => {
  const toolchain = spawnSync("rustc", ["-vV"], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert.ifError(toolchain.error);
  assert.equal(toolchain.status, 0, toolchain.stderr);
  if (!/^host: .*windows-msvc$/m.test(toolchain.stdout)) {
    t.skip("the native linker regression requires a Windows MSVC host toolchain");
    return;
  }

  const temporaryRoot = path.resolve(os.tmpdir());
  const scratch = mkdtempSync(path.join(temporaryRoot, "cli-manager helper-runtime-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(scratch)), temporaryRoot);
    assert.ok(path.basename(scratch).startsWith("cli-manager helper-runtime-"));
    rmSync(scratch, { recursive: true, force: true });
  });

  const run = (command, args, env = {}) => {
    const result = spawnSync(command, args, {
      cwd: scratch,
      env: { ...process.env, ...env },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    assert.ifError(result.error);
    return result;
  };
  const succeeded = (result) => {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };

  const buildScript = fileURLToPath(new URL("../src-tauri/helpers/build.rs", import.meta.url));
  const driverSource = path.join(scratch, "build-driver.rs");
  const driverBinary = path.join(scratch, "build-driver.exe");
  const buildOutput = path.join(scratch, "build-output");
  mkdirSync(buildOutput);
  // Compile the actual build entry. Resource compilation is covered by real Cargo builds;
  // this stub lets the native regression isolate runtime selection without extra crates.
  writeFileSync(driverSource, `
mod embed_resource {
    pub const NONE: () = ();
    pub struct Resource;
    pub fn compile_for<P, B>(_: P, _: B, _: ()) -> Resource { Resource }
    impl Resource {
        pub fn manifest_optional(self) -> Result<(), String> { Ok(()) }
    }
}
include!(${JSON.stringify(buildScript.replaceAll("\\", "/"))});
`);
  succeeded(run("rustc", [driverSource, "--edition=2021", "--crate-name=build_driver", "-o", driverBinary]));
  const emitted = run(driverBinary, [], {
    OUT_DIR: buildOutput, CARGO_CFG_TARGET_OS: "windows", CARGO_CFG_TARGET_ENV: "msvc",
  });
  succeeded(emitted);
  const runtimeArguments = emitted.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("cargo:rustc-link-arg-bins="))
    .flatMap((line) => ["-C", `link-arg=${line.slice("cargo:rustc-link-arg-bins=".length)}`]);
  for (const [targetOs, targetEnvironment] of [["windows", "gnu"], ["linux", "gnu"], ["macos", ""]]) {
    const otherTarget = run(driverBinary, [], {
      OUT_DIR: buildOutput, CARGO_CFG_TARGET_OS: targetOs, CARGO_CFG_TARGET_ENV: targetEnvironment,
    });
    succeeded(otherTarget);
    assert.doesNotMatch(otherTarget.stdout, /^cargo:rustc-link-arg-bins=/m);
  }

  const nativeSource = path.join(scratch, "runtime-probe.c");
  const nativeObject = path.join(scratch, "runtime-probe.obj");
  writeFileSync(nativeSource, `
int runtime_probe(int index) {
    volatile char buffer[64];
    for (int i = 0; i < 64; i++) buffer[i] = (char)i;
    return buffer[index & 63];
}
`);
  succeeded(run("cl.exe", ["/nologo", "/c", "/GS", "/MD", "/Od", nativeSource, `/Fo${nativeObject}`]));

  const shadowLibraries = path.join(scratch, "shadow-libraries");
  mkdirSync(shadowLibraries);
  // Tauri's placeholder is a bare empty COFF object, not an archive. Reproduce
  // that format so MSVC ignores it with LNK4003 and reports the missing CRT.
  const placeholder = Buffer.alloc(82);
  readFileSync(nativeObject).copy(placeholder, 0, 0, 2);
  placeholder.writeUInt16LE(1, 2);
  placeholder.writeUInt32LE(60, 8);
  placeholder.writeUInt32LE(1, 12);
  placeholder.writeUInt16LE(0x184, 18);
  placeholder.write(".drectve", 20, "ascii");
  placeholder.writeUInt32LE(60, 40);
  placeholder.writeUInt32LE(0x100a00, 56);
  placeholder.write(".drectve", 60, "ascii");
  placeholder.writeUInt16LE(1, 72);
  placeholder[76] = 3;
  placeholder.writeUInt32LE(4, 78);
  writeFileSync(path.join(shadowLibraries, "msvcrt.lib"), placeholder);
  const probeSource = path.join(scratch, "runtime-probe.rs");
  writeFileSync(probeSource, `
extern "C" { fn runtime_probe(index: i32) -> i32; }
fn main() { assert_eq!(unsafe { runtime_probe(5) }, 5); }
`);
  const probeArguments = [probeSource, "--edition=2021", "--crate-name=runtime_probe",
    "-C", "opt-level=0", "-C", `link-arg=${nativeObject}`,
    "-C", `link-arg=/LIBPATH:${shadowLibraries}`];

  const unfixed = run("rustc", [...probeArguments, "-o", path.join(scratch, "unfixed.exe")]);
  assert.notEqual(unfixed.status, 0, "the shadow library must reproduce the original link failure");
  const unfixedDiagnostics = `${unfixed.stdout}\n${unfixed.stderr}`;
  assert.match(unfixedDiagnostics, /LNK4003/);
  assert.match(unfixedDiagnostics, /__security_cookie/);

  const fixedBinary = path.join(scratch, "fixed.exe");
  succeeded(run("rustc", [...probeArguments, ...runtimeArguments, "-o", fixedBinary]));
  succeeded(run(fixedBinary, []));
});
