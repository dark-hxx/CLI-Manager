import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('../src-tauri/installer/cleanup.ps1', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32' };
const executableNames = ['cli-manager.exe', 'cli-manager-web-daemon.exe', 'cli-manager-daemon.exe', 'cli-manager-codex-proxy.exe'];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cli-manager-cleanup-'));
  const install = path.join(root, 'installed app');
  const other = path.join(root, 'other app');
  const discovery = path.join(root, 'discovery');
  await Promise.all([install, other, discovery].map(dir => mkdir(dir)));
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  async function start(dir, name) {
    const target = path.join(dir, name);
    await copyFile(path.join(process.env.SystemRoot, 'System32', 'ping.exe'), target);
    const child = spawn(target, ['-t', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
    children.push(child);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    return child;
  }
  return { root, install, other, discovery, start };
}

function cleanup(install, discovery) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-InstallDirectory', install, '-DiscoveryDirectory', discovery], { windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
  });
}

test('cleanup stops only exact installed paths, tolerates missing discovery, and is repeatable', windowsOnly, async t => {
  const f = await fixture(t);
  const targets = await Promise.all(executableNames.map(name => f.start(f.install, name)));
  const unrelated = await f.start(f.other, 'cli-manager-web-daemon.exe');
  const result = await cleanup(f.install, f.discovery);
  assert.equal(result.code, 0, result.output);
  for (const target of targets) assert.notEqual(target.exitCode ?? target.signalCode, null);
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
  assert.equal((await cleanup(f.install, f.discovery)).code, 0);
});

test('cleanup sends authenticated graceful Web and PTY shutdown before fallback', windowsOnly, async t => {
  const f = await fixture(t);
  const seen = [];
  for (const web of [true, false]) {
    const owner = await f.start(f.install, web ? 'cli-manager-web-daemon.exe' : 'cli-manager-daemon.exe');
    const server = net.createServer(socket => {
      let pending = '';
      socket.on('error', () => {});
      socket.on('data', data => {
        pending += data;
        while (pending.includes('\n')) {
          const index = pending.indexOf('\n');
          const frame = JSON.parse(pending.slice(0, index));
          pending = pending.slice(index + 1);
          seen.push([web, frame.type]);
          if (frame.type === 'auth') {
            assert.equal(frame.token, 'isolated-test-token');
            if (web) assert.equal(frame.protocol_version, 7);
            else socket.write('{"type":"auth_ok"}\n');
          } else {
            socket.write(JSON.stringify({ type: 'ok', id: frame.id }) + '\n');
            if (frame.type === 'shutdown') owner.kill();
          }
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    await writeFile(path.join(f.discovery, web ? 'web-daemon.json' : 'daemon.json'), JSON.stringify({
      pid: owner.pid, port: server.address().port, token: 'isolated-test-token', protocolVersion: 7,
    }));
  }
  const result = await cleanup(f.install, f.discovery);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(seen, [[true, 'auth'], [true, 'shutdown'], [false, 'auth'], [false, 'close_all'], [false, 'routing_stop'], [false, 'shutdown']]);
  assert.ok(!result.output.includes('isolated-test-token'));
});

test('discovery for a different installation is never contacted', windowsOnly, async t => {
  const f = await fixture(t);
  const other = await f.start(f.other, 'cli-manager-web-daemon.exe');
  let contacted = false;
  const server = net.createServer(socket => { contacted = true; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await writeFile(path.join(f.discovery, 'web-daemon.json'), JSON.stringify({
    pid: other.pid, port: server.address().port, token: 'unused', protocolVersion: 7,
  }));
  assert.equal((await cleanup(f.install, f.discovery)).code, 0);
  assert.equal(contacted, false);
  assert.equal(other.exitCode, null);
});

test('drive root is rejected', windowsOnly, async t => {
  const f = await fixture(t);
  assert.notEqual((await cleanup(path.parse(f.install).root, f.discovery)).code, 0);
});

test('NSIS compiles both embedded lifecycle hooks', windowsOnly, async t => {
  const compiler = path.join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'makensis.exe');
  if (!existsSync(compiler)) { t.skip('Tauri NSIS compiler not installed'); return; }
  const f = await fixture(t);
  const hooks = fileURLToPath(new URL('../src-tauri/installer/hooks.nsh', import.meta.url));
  const source = path.join(f.root, 'test.nsi');
  await writeFile(source, `Unicode true
!include LogicLib.nsh
!macro CheckIfAppIsRunning executableName productName
!error "Unscoped process termination must be replaced"
!macroend
!include "${hooks}"
Name "Cleanup hook compile test"
OutFile "${path.join(f.root, 'compile-only.exe')}"
RequestExecutionLevel user
Section
!insertmacro NSIS_HOOK_PREINSTALL
!insertmacro CheckIfAppIsRunning "cli-manager.exe" "CLI-Manager"
WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
Section "Uninstall"
!insertmacro NSIS_HOOK_PREUNINSTALL
!insertmacro CheckIfAppIsRunning "cli-manager.exe" "CLI-Manager"
SectionEnd
`);
  const result = spawnSync(compiler, ['/V2', source], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
