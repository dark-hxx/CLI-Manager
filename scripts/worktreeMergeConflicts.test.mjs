import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createHarness, deferred, makeDetail } from './fixtures/worktreeConflictHarness.mjs';

// Bundle actual TS modules without changing product dependencies or relying on Node TS stripping.
const result = await build({
  stdin: {
    contents: [
      'export { ConflictController } from "./src/features/projects/lib/conflictController.ts";',
      'export { buildConflictRows } from "./src/features/projects/lib/conflictRows.ts";',
      'export { conflictEditNewline, normalizeConflictEdit, conflictChoiceText } from "./src/features/projects/lib/conflictTextEdit.ts";',
      'export { conflictLineWidth } from "./src/features/projects/lib/conflictSelection.ts";',
      'export { conflictChoiceProgress, conflictFileState } from "./src/features/projects/lib/conflictProgress.ts";',
    ].join('\n'),
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { ConflictController, buildConflictRows, conflictEditNewline, normalizeConflictEdit, conflictChoiceText, conflictLineWidth,
  conflictChoiceProgress, conflictFileState } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const setup = (t, options) => {
  const harness = createHarness(options);
  const controller = new ConflictController(harness.invoke, harness.context);
  t.after(() => controller.dispose());
  return { ...harness, controller };
};

test('UTF-8 offsets preserve BOM, non-ASCII and semantic left/right alignment', () => {
  const rows = buildConflictRows(makeDetail());
  assert.equal(rows[0].left, '﻿前文😀');
  assert.equal(rows[2].left, 'target-0');
  assert.equal(rows[2].right, 'worktree-0');
  assert.equal(rows.at(-1).right, 'context-0');
  assert.equal(rows.filter((row) => row.kind === 'control').length, 1);
  assert.deepEqual(buildConflictRows({ ...makeDetail(), capability: 'whole_file' }), []);
});

test('choice progress counts actual blocks, including an intentionally empty result', () => {
  const detail = makeDetail('file-0', 2);
  detail.draft.choices.stale = { kind: 'worktree' };
  assert.deepEqual(conflictChoiceProgress(detail), { chosen: 0, total: 2, complete: false });
  detail.draft.choices['block-0'] = { kind: 'worktree' };
  assert.deepEqual(conflictChoiceProgress(detail), { chosen: 1, total: 2, complete: false });
  detail.draft.choices['block-1'] = { kind: 'edited', text: '' };
  assert.deepEqual(conflictChoiceProgress(detail), { chosen: 2, total: 2, complete: true });
  assert.equal(conflictChoiceProgress({ ...detail, blocks: [] }).complete, false);
  assert.equal(conflictChoiceProgress({ ...detail, capability: 'whole_file' }).complete, false);
  assert.equal(conflictChoiceProgress(null).complete, false);
});

test('accept right updates block status immediately; autosave alone never confirms the file', async (t) => {
  const { controller, calls } = setup(t, { total: 2 });
  await controller.initialize();
  const file = controller.getSnapshot().page.files[0];
  assert.equal(conflictFileState(file, controller.getSnapshot().detail), 'unconfirmed');
  controller.choose('block-0', { kind: 'worktree' });
  assert.equal(conflictFileState(file, controller.getSnapshot().detail), 'pendingConfirmation');
  assert.equal(controller.getSnapshot().snapshot.resolved, 0);
  await controller.flush();
  assert.equal(conflictFileState(file, controller.getSnapshot().detail), 'pendingConfirmation');
  assert.equal(calls.some((call) => call.name.endsWith('resolve_conflict_file')), false);
  await controller.select('file-1');
  assert.equal(conflictFileState(controller.getSnapshot().page.files[1], controller.getSnapshot().detail), 'unconfirmed');
  await controller.select('file-0');
  assert.equal(conflictFileState(file, controller.getSnapshot().detail), 'pendingConfirmation');
  await controller.resolve();
  assert.equal(conflictFileState(controller.getSnapshot().page.files[0], controller.getSnapshot().detail), 'resolved');
  assert.equal(controller.getSnapshot().snapshot.resolved, 1);
});

test('failed draft save or file confirmation never reports a resolved file', async (t) => {
  const { controller, controls, calls } = setup(t, { total: 1 });
  await controller.initialize();
  controller.choose('block-0', { kind: 'worktree' });
  controls.failSave = true;
  await assert.rejects(controller.resolve(), /disk_full/);
  assert.equal(controller.getSnapshot().dirty, true);
  assert.equal(controller.getSnapshot().snapshot.resolved, 0);
  assert.equal(calls.some((call) => call.name.endsWith('resolve_conflict_file')), false);
  controls.failSave = false;
  await controller.recheck();
  controls.before = (name) => { if (name.endsWith('resolve_conflict_file')) throw new Error('external_change'); };
  await assert.rejects(controller.resolve(), /external_change/);
  const view = controller.getSnapshot();
  assert.equal(view.needsRecheck, true);
  assert.equal(view.snapshot.resolved, 0);
  assert.equal(conflictFileState(view.page.files[0], view.detail), 'pendingConfirmation');
});

test('manual edits preserve CRLF, BOM, Unicode and final-newline intent; mixed style fails closed', () => {
  assert.equal(conflictEditNewline(makeDetail().source), '\r\n');
  assert.equal(conflictEditNewline('a\nb'), '\n');
  assert.equal(conflictEditNewline('a\r\nb\n'), null);
  assert.equal(normalizeConflictEdit('﻿中文😀\nsecond\n', '\r\n'), '﻿中文😀\r\nsecond\r\n');
  assert.equal(normalizeConflictEdit('no final newline', '\r\n'), 'no final newline');
  assert.equal(normalizeConflictEdit('a\r\nb', '\r\n'), 'a\r\nb');
  assert.ok(conflictLineWidth('中文\t😀') >= conflictLineWidth('xxxx'));
});

test('manual result preserves chosen sides, arbitrary mixed lines and an empty edit', () => {
  const block = { ...makeDetail().blocks[0], base: 'left-2\r\nleft-3\r\nleft-4\r\n', worktree: 'right-6\r\nright-7\r\nright-8' };
  assert.equal(conflictChoiceText(block), block.base + block.worktree);
  assert.equal(conflictChoiceText(block, { kind: 'base_branch' }), block.base);
  assert.equal(conflictChoiceText(block, { kind: 'worktree' }), block.worktree);
  assert.equal(conflictChoiceText(block, { kind: 'both' }), block.base + block.worktree);
  const mixed = normalizeConflictEdit('left-2\nleft-3\nright-7\nright-8', '\r\n');
  assert.equal(conflictChoiceText(block, { kind: 'edited', text: mixed }), 'left-2\r\nleft-3\r\nright-7\r\nright-8');
  assert.equal(conflictChoiceText(block, { kind: 'edited', text: '' }), '');
});

test('split gutters track real lines rather than padded counterpart rows', () => {
  const detail = makeDetail();
  detail.blocks[0].base = 'left one\nleft two\n';
  const rows = buildConflictRows(detail);
  assert.equal(rows[2].leftNumber, 2); assert.equal(rows[2].rightNumber, 2);
  assert.equal(rows[3].leftNumber, 3); assert.equal(rows[3].rightNumber, null);
  assert.equal(rows.at(-1).leftNumber, 4); assert.equal(rows.at(-1).rightNumber, 3);
});

test('managed initialization is single flight and loads only the first unresolved file', async (t) => {
  const { controller, calls, controls } = setup(t);
  await Promise.all(Array.from({ length: 100 }, () => controller.initialize()));
  assert.equal(controls.peak, 1);
  assert.deepEqual(calls.map((call) => call.name), ['git_worktree_probe_conflicts', 'git_worktree_conflict_status', 'git_worktree_conflict_file']);
  assert.equal(controller.getSnapshot().selectedId, 'file-0');
});

test('explicit clean opening prepares once and loads the first conflict', async (t) => {
  const { controller, calls, controls } = setup(t, { probeKind: 'none' });
  await Promise.all([controller.initialize(true), controller.initialize(true)]);
  assert.deepEqual(calls.map((call) => call.name), [
    'git_worktree_probe_conflicts', 'git_worktree_prepare_conflicts',
    'git_worktree_conflict_status', 'git_worktree_conflict_file',
  ]);
  assert.equal(calls[1].args.expectedHeadOid, 'head');
  assert.equal(calls[1].args.expectedBaseOid, 'base');
  assert.equal(controller.getSnapshot().detail.fileId, 'file-0');
  assert.equal(controls.peak, 1);
});

test('opening never automatically prepares foreign or recovery operations', async (t) => {
  const { context } = createHarness();
  for (const kind of ['foreign', 'recovery']) {
    const calls = [];
    const controller = new ConflictController(async (name) => {
      calls.push(name);
      return { kind, snapshot: null, error: 'foreign_operation' };
    }, context);
    t.after(() => controller.dispose());
    await controller.initialize(true);
    assert.deepEqual(calls, ['git_worktree_probe_conflicts']);
    assert.equal(controller.getSnapshot().snapshot, null);
  }
});

test('confirming a file selects the next conflict but never implicitly commits', async (t) => {
  const { controller, calls } = setup(t, { total: 2 });
  await controller.initialize(true);
  controller.choose('block-0', { kind: 'base_branch' });
  await controller.resolve();
  assert.equal(controller.getSnapshot().selectedId, 'file-1');
  controller.choose('block-0', { kind: 'worktree' });
  await controller.resolve();
  assert.equal(controller.getSnapshot().snapshot.state, 'ready');
  assert.equal(controller.getSnapshot().detail, null);
  assert.equal(calls.some((call) => /continue_conflicts|release_conflicts/.test(call.name)), false);
  await controller.continueMerge('Resolve and merge');
  await controller.release();
  assert.deepEqual(calls.slice(-2).map((call) => call.name), [
    'git_worktree_continue_conflicts', 'git_worktree_release_conflicts',
  ]);
});

test('disposing during probe prevents automatic preparation', async (t) => {
  const { controller, calls, controls } = setup(t, { probeKind: 'none' });
  const started = deferred(); const gate = deferred();
  controls.before = async (name) => {
    if (name === 'git_worktree_probe_conflicts') { started.resolve(); await gate.promise; }
  };
  const opening = controller.initialize(true);
  await started.promise; controller.dispose(); gate.resolve(); await opening;
  assert.deepEqual(calls.map((call) => call.name), ['git_worktree_probe_conflicts']);
});

test('100 rapid selections serialize IPC and discard an older in-flight response', async (t) => {
  const { controller, controls, calls } = setup(t);
  await controller.initialize();
  const initialReads = calls.filter((call) => call.name.endsWith('conflict_file')).length;
  const started = deferred(); const gate = deferred();
  controls.before = async (name) => { if (name.endsWith('conflict_file')) { started.resolve(); await gate.promise; } };
  const first = controller.select('file-0'); await started.promise;
  const selections = Array.from({ length: 100 }, (_, i) => controller.select(`file-${i % 3}`));
  gate.resolve(); await Promise.all([first, ...selections]);
  assert.equal(controls.peak, 1);
  assert.equal(controller.getSnapshot().selectedId, 'file-0');
  assert.equal(controller.getSnapshot().loading, false);
  assert.equal(calls.filter((call) => call.name.endsWith('conflict_file')).length - initialReads, 2);
});

test('failed save blocks navigation, preserves edits and retries exact operation', async (t) => {
  const { controller, controls, calls } = setup(t);
  await controller.initialize(); await controller.select('file-0');
  controller.choose('block-0', { kind: 'edited', text: 'user text\r\n' });
  controls.failSave = true;
  await assert.rejects(controller.select('file-1'), /disk_full/);
  assert.equal(controller.getSnapshot().selectedId, 'file-0');
  assert.equal(controller.getSnapshot().dirty, true);
  controls.failSave = false; await controller.flush();
  const saves = calls.filter((call) => call.name.endsWith('save_conflict_draft'));
  assert.deepEqual(saves[0].args, saves[1].args);
  assert.equal(controller.getSnapshot().dirty, false);
  assert.equal(controller.getSnapshot().detail.version, 'version-1');
  await controller.select('file-1');
  assert.equal(controller.getSnapshot().selectedId, 'file-1');
});

test('lost save response retries idempotently; edits during save use refreshed CAS', async (t) => {
  const { controller, controls, calls } = setup(t);
  await controller.initialize(); await controller.select('file-0');
  controller.choose('block-0', { kind: 'base_branch' });
  let once = true;
  controls.after = (name) => { if (name.endsWith('save_conflict_draft') && once) { once = false; throw new Error('response_lost'); } };
  await assert.rejects(controller.flush(), /response_lost/);
  controller.choose('block-0', { kind: 'edited', text: 'newer input' });
  await controller.flush();
  const saves = calls.filter((call) => call.name.endsWith('save_conflict_draft'));
  assert.deepEqual(saves[0].args, saves[1].args);
  assert.equal(saves[2].args.version, 'version-1');
  assert.equal(saves[2].args.draftRevision, 1);
  assert.equal(controller.getSnapshot().detail.draft.choices['block-0'].text, 'newer input');
  assert.equal(controller.getSnapshot().detail.draft.revision, 2);
  assert.equal(controls.peak, 1);
});

test('autosave keeps editing enabled and drains edits made while IPC is in flight', async (t) => {
  const { controller, controls } = setup(t);
  await controller.initialize(); await controller.select('file-0');
  const started = deferred(); const gate = deferred();
  controls.before = async (name) => { if (name.endsWith('save_conflict_draft')) { started.resolve(); await gate.promise; } };
  controller.choose('block-0', { kind: 'edited', text: 'first' });
  const flush = controller.flush(); await started.promise;
  assert.equal(controller.getSnapshot().saving, true);
  controller.choose('block-0', { kind: 'edited', text: 'latest' });
  gate.resolve(); await flush;
  assert.equal(controller.getSnapshot().detail.draft.choices['block-0'].text, 'latest');
  assert.equal(controller.getSnapshot().dirty, false);
  assert.equal(controller.getSnapshot().saving, false);
});

test('64,887 files expose bounded first/middle/last pages, refresh stays single flight', async (t) => {
  const { controller, calls, controls } = setup(t, { total: 64887 });
  await controller.initialize();
  assert.equal(controller.getSnapshot().page.files.length, 200);
  await controller.page(32400); assert.equal(controller.getSnapshot().page.files[0].fileId, 'file-32400');
  await controller.page(64800); assert.equal(controller.getSnapshot().page.files.length, 87);
  assert.equal(controller.getSnapshot().page.nextCursor, null);
  await Promise.all(Array.from({ length: 100 }, () => controller.recheck()));
  assert.equal(calls.filter((call) => call.name.endsWith('recheck_conflicts')).length, 1);
  assert.equal(controls.peak, 1);
});

test('prepare pins expected OIDs and terminal recheck does not query active index', async (t) => {
  const { controller, calls } = setup(t, { probeKind: 'none' });
  await controller.initialize(); await controller.prepare();
  const prepare = calls.find((call) => call.name.endsWith('prepare_conflicts'));
  assert.equal(prepare.args.expectedHeadOid, 'head'); assert.equal(prepare.args.expectedBaseOid, 'base');
  await controller.abort();
  const count = calls.length; await controller.recheck();
  assert.deepEqual(calls.slice(count).map((call) => call.name), ['git_worktree_recheck_conflicts']);
  await controller.release();
  assert.equal(calls.at(-1).name, 'git_worktree_release_conflicts');
});

test('dispose ignores late responses and stops follow-up reads after save', async (t) => {
  const { controller, controls, calls } = setup(t);
  await controller.initialize(); await controller.select('file-0');
  controller.choose('block-0', { kind: 'both' });
  const started = deferred(); const gate = deferred();
  controls.before = async (name) => { if (name.endsWith('save_conflict_draft')) { started.resolve(); await gate.promise; } };
  const flush = controller.flush(); await started.promise;
  controller.dispose(); const count = calls.length; gate.resolve(); await flush;
  assert.equal(calls.length, count);
});
