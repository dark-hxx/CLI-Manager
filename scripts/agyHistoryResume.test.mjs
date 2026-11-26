import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const built = await build({ stdin: { contents: `
  export * from './features/history/api/historyResumeCommand';
  export * from './features/history/lib/historyResumeEnvironment';
  export * from './features/projects/api/agySessionLocation';
  export * from './features/projects/api/projectStartupCommand';
  export * from './shared/lib/cliTools';`, resolveDir: root },
  bundle: true, platform: 'node', format: 'esm', write: false });
const { buildHistoryResumeCommand, hasResumeProvenance, verifyAgyHistoryTarget, resolveHistoryResumeEnvironment,
  resolveProjectStartupCommand, sameAgyCwd, validAgyTabLocation, isAgyCommand, CLI_TOOL_DESCRIPTORS,
  resolveCliToolHistorySourceId, resolveCliToolIconKey, resolveCliToolImagePasteMode } = await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);

const A = 'aaaaaaaa-1111-4444-8888-111111111111', B = 'bbbbbbbb-2222-4444-8888-222222222222';
const tail = `/.gemini/antigravity-cli/brain/${A}/.system_generated/logs/transcript.jsonl`;
const record = { source: 'antigravity', session_id: A, cwd: '/work/Repo', project_key: 'repo', file_path: '/Users/test' + tail };
const project = { cli_tool: 'agy', cli_args: `--model m --conversation ${B} --continue -c -p "once" --sandbox`, startup_cmd: '', shell: 'zsh', path: '/work/Repo' };
const unc = (distro, path) => `\\\\wsl.localhost\\${distro}${path.replaceAll('/', '\\')}`;

test('project preset is agy, not Gemini/IDE or a prompt mentioning agy', () => {
  assert.equal(CLI_TOOL_DESCRIPTORS.filter(x => x.command === 'agy').length, 1);
  for (const cmd of ['agy', 'AGY.EXE', 'agy --model claude', '"/Applications/My CLI/agy" --model gemini', '& "C:\\Apps Test\\AGY.CMD" --effort high']) {
    assert.equal(isAgyCommand(cmd), true, cmd); assert.equal(resolveCliToolIconKey(cmd), 'antigravity');
    assert.equal(resolveCliToolHistorySourceId(cmd), 'antigravity'); assert.equal(resolveCliToolImagePasteMode(cmd), 'unsupported');
  }
  for (const cmd of ['antigravity', 'echo agy', 'notagy', 'agy-wrapper', 'gemini -p agy', 'cmd /c agy', '"$HOME/agy"']) {
    assert.equal(isAgyCommand(cmd), false, cmd); assert.notEqual(resolveCliToolHistorySourceId(cmd), 'antigravity');
  }
});

test('native macOS, Windows PowerShell/CMD and WSL preserve fresh quoted arguments; explicit startup wins', () => {
  const args = '--model "user choice" --prompt \'one shot\'';
  for (const [shell, tool, exe] of [
    ['zsh', '"/Applications/My CLI/agy"', '"/Applications/My CLI/agy"'],
    ['pwsh', '"C:\\Tools A\\agy.exe"', '& "C:\\Tools A\\agy.exe"'],
    ['cmd', '"C:\\Tools A\\agy.exe"', '"C:\\Tools A\\agy.exe"'],
    ['wsl', '"/opt/My CLI/agy"', '"/opt/My CLI/agy"'],
  ]) {
    assert.equal(resolveProjectStartupCommand({ ...project, shell, cli_tool: `${tool} --sandbox`, cli_args: args }), `${exe} --sandbox ${args}`);
  }
  assert.equal(resolveProjectStartupCommand({ ...project, startup_cmd: 'echo "keep me"' }), 'echo "keep me"');
});

test('A/B selection copies only allowlisted structured options and never switches to latest', () => {
  assert.equal(buildHistoryResumeCommand(record, project), `agy --conversation ${A} --model m --sandbox`);
  assert.equal(buildHistoryResumeCommand(record, { ...project, startup_cmd: `agy -p foo --conversation ${B}` }), `agy --conversation ${A}`);
  assert.equal(buildHistoryResumeCommand(record, { ...project, cli_args: '--model foo & echo once' }), `agy --conversation ${A}`);
  assert.equal(buildHistoryResumeCommand(record, { ...project, cli_tool: 'gemini' }), null);
  assert.equal(buildHistoryResumeCommand(record, null), `agy --conversation ${A}`);
});

test('legacy, cached-only, changed origin, malformed locator/UUID/cwd never authorize agy history resume', () => {
  const ref = { sourceId: 'antigravity', sourceInstanceId: 'instance-a', sourceSessionId: A, transportKind: 'local', rawPointers: [{rawKey: record.file_path}] };
  const wsl = { ...record, file_path: unc('Ubuntu', '/home/a' + tail) };
  assert.equal(hasResumeProvenance(record), true); assert.equal(hasResumeProvenance(wsl), true);
  const wslRef = { ...ref, transportKind: 'wsl', rawPointers: [{ rawKey: wsl.file_path }] };
  assert.equal(hasResumeProvenance({ ...wsl, session_ref: wslRef }), true);
  assert.equal(hasResumeProvenance({ ...wsl, session_ref: { ...wslRef, rawPointers: [{ rawKey: wsl.file_path.replace('Ubuntu', 'Other') }] } }), false);
  for (const patch of [
    { session_id: undefined }, { session_id: A + '\n' }, { session_id: 'x; echo' }, { session_id: B },
    { file_path: record.file_path.replace('antigravity-cli', 'antigravity') }, { file_path: record.file_path + '.bak' },
    { file_path: record.file_path.replace('/Users/test', '/Users/test/../other') }, { file_path: '//fileserver/user' + tail },
    { session_ref: { ...ref, rawPointers: undefined } }, { session_ref: { ...ref, rawPointers: [null] } },
    { session_ref: { ...ref, transportKind: 'ssh' } }, { session_ref: { ...ref, transportKind: 'wsl' } },
    { file_path: wsl.file_path, session_ref: ref }, { remote_identity: {} }, { favoriteSnapshot: true }, { freshness_state: 'offline' },
    { freshness_state: 'stale' }, { read_only: true }, { cwd: null }, { cwd: 'relative/repo' },
    { session_id: '00000000-0000-0000-0000-000000000000', file_path: record.file_path.replace(A, '00000000-0000-0000-0000-000000000000') },
  ]) assert.equal(buildHistoryResumeCommand({ ...record, ...patch }), null, JSON.stringify(patch));
});

test('fresh scoped identity and live cwd are mandatory before native launch (including linked worktree)', async () => {
  const env = resolveHistoryResumeEnvironment(record, null, null, 'zsh', 'macos');
  const check = (fresh, exists = true, proj = project, launch = env, worktree) => verifyAgyHistoryTarget(record, proj, worktree, launch, async () => fresh, async path => exists && path === env.cwd);
  await check(record); await check(record, true, { ...project, path: '/work/Main' }, env, record.cwd);
  const withRef = { ...record, session_ref: { sourceId: record.source, sourceSessionId: A, sourceInstanceId: 'a', transportKind: 'local', rawPointers: [{rawKey: record.file_path}] } };
  const verifyRef = fresh => verifyAgyHistoryTarget(withRef, null, undefined, env, async () => fresh, async () => true);
  await verifyRef(withRef);
  await assert.rejects(verifyRef(record));
  await assert.rejects(verifyRef({ ...withRef, session_ref: { ...withRef.session_ref, sourceInstanceId: 'b' } }));
  for (const patch of [{ session_id: B }, { source: 'gemini' }, { cwd: '/work/new' }, { file_path: '/another' + tail }]) await assert.rejects(check({ ...record, ...patch }));
  await assert.rejects(check(record, false)); await assert.rejects(check(record, true, { ...project, path: '/work/repo' }));
  await assert.rejects(check(record, true, null, { ...env, cwd: '/elsewhere' }));
  await assert.rejects(verifyAgyHistoryTarget(record, null, undefined, env, async () => { throw Error('not in active scope'); }, async () => true));
});

test('WSL location is bound to the transcript distro, not a default distro or host shell', async () => {
  const wsl = { ...record, file_path: unc('Distro-A', '/home/test' + tail) };
  const env = resolveHistoryResumeEnvironment(wsl, null, null, undefined, 'windows');
  assert.deepEqual(env, { cwd: unc('Distro-A', record.cwd), shell: 'wsl', env: {} });
  const verify = launch => verifyAgyHistoryTarget(wsl, null, undefined, launch, async () => wsl, async () => true);
  await verify(env);
  for (const launch of [{ ...env, shell: 'pwsh' }, { ...env, cwd: unc('Distro-B', record.cwd) }, { ...env, cwd: unc('Distro-A', '/work/Other') }]) await assert.rejects(verify(launch));
  assert.equal(validAgyTabLocation(env.cwd, 'wsl', 'wsl'), true);
  assert.equal(validAgyTabLocation(env.cwd, 'wsl', 'local'), false);
  assert.equal(validAgyTabLocation('C:\\work', 'wsl', 'wsl'), false);
  assert.equal(validAgyTabLocation('/work', 'bash', 'ssh'), false);
  assert.equal(validAgyTabLocation('/work', 'bash', 'local', 'windows'), false);
  assert.equal(validAgyTabLocation(env.cwd, 'wsl', 'wsl', 'macos'), false);
  assert.equal(sameAgyCwd('C:\\WORK', 'c:/work/'), true);
  assert.equal(sameAgyCwd('/work/Repo', '/work/repo'), false);
});
