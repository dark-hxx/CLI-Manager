// Opt-in live CLI check. Uses the user's existing provider; never rewrites its configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

const launcher = process.env.CLI_MANAGER_TEST_CODEX;
assert(launcher, 'Set CLI_MANAGER_TEST_CODEX to the installed Codex launcher');
const proxy = process.env.CLI_MANAGER_TEST_PROXY || path.resolve('src-tauri/target/debug/cli-manager-codex-proxy.exe');
const nonce = `WEB_RUNTIME_${Date.now()}`;

function client() {
  const child = spawn(proxy, ['app-server'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLI_MANAGER_CODEX_LAUNCHER: launcher, CLI_MANAGER_CODEX_LAUNCHER_ARGS: '[]' },
  });
  child.stderr.resume();
  let sequence = 0;
  const pending = new Map();
  let turn;
  const lines = readline.createInterface({ input: child.stdout });
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const fail = error => { for (const request of pending.values()) request.reject(error); pending.clear(); turn?.reject(error); };
  child.on('error', () => fail(new Error('CLI spawn failed')));
  child.on('exit', code => fail(new Error(`CLI exited (${code})`)));
  lines.on('line', line => {
    let packet;
    try { packet = JSON.parse(line); } catch { return fail(new Error('Invalid CLI protocol JSON')); }
    if (packet.id !== undefined && packet.method) {
      send({ id: packet.id, result: { decision: 'decline' } });
      return fail(new Error('Read-only smoke unexpectedly required approval'));
    }
    if (pending.has(packet.id)) {
      const request = pending.get(packet.id);
      pending.delete(packet.id);
      if (packet.error) request.reject(new Error(`RPC ${request.method} failed (${packet.error.code})`));
      else request.resolve(packet.result);
    }
    if (packet.method === 'item/agentMessage/delta' && turn) turn.deltas += packet.params.delta || '';
    if (packet.method === 'item/completed' && packet.params.item.type === 'agentMessage' && turn) turn.text += packet.params.item.text || '';
    if (packet.method === 'error' && turn && !packet.params?.willRetry) turn.reject(new Error('CLI turn reported an error'));
    if (packet.method === 'turn/completed' && turn) {
      if (packet.params.turn.status !== 'completed') turn.reject(new Error(`Turn ended ${packet.params.turn.status}`));
      else turn.resolve({ text: turn.text, deltas: turn.deltas });
      turn = undefined;
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${method} timed out`)); }, 60_000);
    pending.set(id, { method, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    send({ id, method, params });
  });
  return {
    async initialize() {
      await rpc('initialize', { clientInfo: { name: 'cli_manager_web_smoke', version: '1.0.0' }, capabilities: {} });
      send({ method: 'initialized', params: {} });
    },
    async thread(sessionId) {
      const result = await rpc(sessionId ? 'thread/resume' : 'thread/start', { cwd: process.cwd(), approvalPolicy: 'on-request', sandbox: 'read-only', ...(sessionId ? { threadId: sessionId } : {}) });
      if (sessionId) assert.equal(result.thread.id, sessionId, 'Resume must preserve the session ID');
      return result.thread.id;
    },
    async prompt(threadId, text) {
      const completed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Turn timed out')), 180_000);
        turn = { text: '', deltas: '', resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      });
      // Attach rejection handling before waiting for turn/start, which can fail first.
      completed.catch(() => {});
      await rpc('turn/start', { threadId, input: [{ type: 'text', text }] });
      return completed;
    },
    close() { child.stdin.end(); lines.close(); child.kill(); },
  };
}

let connection = client();
try {
  await connection.initialize();
  const sessionId = await connection.thread();
  const first = await connection.prompt(sessionId, `This is a read-only transport smoke test. Do not call tools, read files, or modify anything. Remember this marker: ${nonce}. Reply with only that marker.`);
  assert(first.text.includes(nonce), 'First turn must contain actual assistant text');
  assert(first.deltas.includes(nonce), 'First turn must include streaming text');
  connection.close();
  connection = client();
  await connection.initialize();
  await connection.thread(sessionId);
  const second = await connection.prompt(sessionId, 'Do not call any tools. Reply with only the marker I asked you to remember in the previous turn.');
  assert(second.text.includes(nonce), 'Resumed turn must retain earlier context');
  console.log(JSON.stringify({ passed: true, initialized: true, streamed: true, resumedInNewProcess: true, turns: 2, sessionId }));
} finally {
  connection.close();
}
