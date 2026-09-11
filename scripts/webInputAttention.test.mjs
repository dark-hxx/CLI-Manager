import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/hooks/useWebDeviceBridge.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('bridge.ts', source, ts.ScriptTarget.Latest, true);
const handler = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'executeTerminalCommand');
const code = ts.transpileModule(handler.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup({ fail = false, other = false } = {}) {
  const statuses = { target: { hook: 'attention' }, ...(other ? { other: { hook: 'attention' } } : {}) };
  const calls = [];
  const state = { tabStatuses: statuses, markAttentionInputHandled(id) { calls.push('handled'); statuses[id].hook = 'running'; } };
  const bridges = new Map([['target', { socket: { async write() { calls.push('write'); if (fail) throw new Error('disconnected'); } } }]]);
  const run = new Function('terminalBridges', 'useTerminalStore', 'invoke', 'logWarn', `${code}; return executeTerminalCommand;`)(bridges, { getState: () => state }, async () => calls.push('clear'), () => {});
  return { calls, statuses, run: () => run({ type: 'input', sessionId: 'target', data: '\r' }) };
}

test('successful Web input clears target attention and taskbar', async () => {
  const f = setup(); await f.run();
  assert.equal(f.statuses.target.hook, 'running');
  assert.deepEqual(f.calls, ['write', 'handled', 'clear']);
});
test('other session attention remains visible', async () => {
  const f = setup({ other: true }); await f.run();
  assert.equal(f.statuses.other.hook, 'attention');
  assert.deepEqual(f.calls, ['write', 'handled']);
});
test('failed input does not acknowledge approval', async () => {
  const f = setup({ fail: true }); await assert.rejects(f.run(), /disconnected/);
  assert.equal(f.statuses.target.hook, 'attention');
  assert.deepEqual(f.calls, ['write']);
});
