import assert from 'node:assert/strict';
import test from 'node:test';
import { WorktreeRecoveryGate } from '../src/features/projects/lib/worktreeRecoveryGate.ts';

const ready = { blocked: false, hasJournal: false, canConfirm: false, stateToken: null, revision: null, phase: null, stashOid: null, reason: null };
const blocked = { ...ready, blocked: true, hasJournal: true, canConfirm: true, stateToken: 'original-token' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('100 refresh clicks share one in-flight IPC', async () => {
  const pending = deferred();
  let count = 0;
  const gate = new WorktreeRecoveryGate(() => { count++; return pending.promise; });
  const first = gate.start('project', 'context');
  await tick();
  const requests = Array.from({ length: 100 }, () => gate.refresh());
  assert.ok(requests.every((request) => request === first));
  assert.equal(count, 1);
  pending.resolve(ready);
  await first;
  assert.equal(gate.getSnapshot().phase, 'ready');
});

test('100 context switches discard stale responses and never overlap IPC', async () => {
  const pending = [];
  let active = 0;
  let peak = 0;
  const paths = [];
  const gate = new WorktreeRecoveryGate(async (_command, args) => {
    active++;
    peak = Math.max(active, peak);
    paths.push(args.projectPath);
    const request = deferred();
    pending.push(request);
    const result = await request.promise;
    active--;
    return result;
  });
  const old = gate.start('old', 'old');
  await tick();
  let latest;
  for (let index = 0; index < 100; index++) latest = gate.start(`project-${index}`, `key-${index}`);
  pending[0].resolve(blocked);
  await old;
  await tick();
  assert.deepEqual(paths, ['old', 'project-99']);
  assert.equal(gate.getSnapshot().key, 'key-99');
  assert.equal(gate.getSnapshot().status, null);
  pending[1].resolve(ready);
  await latest;
  assert.equal(peak, 1);
  assert.equal(gate.getSnapshot().phase, 'ready');
});

test('closing invalidates ready state and an old response cannot unlock a reopened dialog', async () => {
  const pending = deferred();
  let count = 0;
  const gate = new WorktreeRecoveryGate(() => ++count === 1 ? Promise.resolve(ready) : pending.promise);
  await gate.start('project', 'same');
  gate.stop();
  assert.equal(gate.getSnapshot().phase, 'loading');
  assert.equal(gate.getSnapshot().key, '');
  const old = gate.start('project', 'same');
  await tick();
  gate.stop();
  pending.resolve(ready);
  await old;
  assert.equal(gate.getSnapshot().phase, 'loading');
  assert.equal(gate.getSnapshot().status, null);
  await gate.refresh();
  assert.equal(count, 2);
});

test('recheck is non-confirming and confirmation uses the token shown when opened', async () => {
  const calls = [];
  const gate = new WorktreeRecoveryGate(async (command, args) => {
    calls.push({ command, args });
    return calls.length === 1 ? blocked : { ...blocked, stateToken: 'new-token' };
  });
  await gate.start('project', 'context');
  const shownToken = gate.getSnapshot().status.stateToken;
  await gate.refresh('recheck');
  assert.deepEqual(calls[1], { command: 'git_worktree_recovery_recheck', args: { projectPath: 'project', stateToken: shownToken, confirm: false } });
  await gate.refresh('confirm', shownToken);
  assert.equal(calls[2].args.stateToken, 'original-token');
  assert.equal(calls[2].args.confirm, true);
});

test('probe errors fail closed, remain retryable, and unsubscribe removes listeners', async () => {
  let count = 0;
  let notifications = 0;
  const gate = new WorktreeRecoveryGate(async () => {
    if (++count === 1) throw { code: 'repository_busy', detail: 'owned elsewhere' };
    return ready;
  });
  const unsubscribe = gate.subscribe(() => notifications++);
  await gate.start('project', 'context');
  assert.equal(gate.getSnapshot().phase, 'error');
  assert.match(gate.getSnapshot().error, /repository_busy/);
  const before = notifications;
  unsubscribe();
  await gate.refresh();
  assert.equal(notifications, before);
  assert.equal(gate.getSnapshot().phase, 'ready');
});
