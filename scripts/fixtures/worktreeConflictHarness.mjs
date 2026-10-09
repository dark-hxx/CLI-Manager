// Frontend-only IPC double. Git safety is exercised by the Rust temporary-repository suite.
export const context = { projectPath: 'C:/project', worktreePath: 'C:/worktree', worktreeBranch: 'feature', baseBranch: 'main' };
export function makeDetail(fileId = 'file-0', count = 1) {
  let source = '﻿前文😀\r\n';
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const start = new TextEncoder().encode(source).length;
    const base = `target-${i}\r\n`;
    const worktree = `worktree-${i}\r\n`;
    source += `<<<<<<< HEAD\r\n${worktree}=======\r\n${base}>>>>>>> main\r\n`;
    blocks.push({ id: `block-${i}`, start, end: new TextEncoder().encode(source).length, base, worktree, ancestor: null });
    source += `context-${i}\r\n`;
  }
  return { fileId, version: 'version-0', capability: 'blocks', reason: null, source, blocks,
    draft: { revision: 0, choices: {}, sourceHash: 'source', operationId: '', payloadHash: '' },
    baseExists: true, worktreeExists: true, markerSize: 7 };
}
export function createHarness({ total = 4, probeKind = 'managed', blockCount = 1 } = {}) {
  let snapshot = { sessionId: 'session', revision: 1, state: 'resolving', worktreeBranch: 'feature', baseBranch: 'main',
    headOid: 'head', baseOid: 'base', total, resolved: 0, unresolved: total, draftCount: 0, listSnapshotId: 'list' };
  const files = new Map();
  const applied = new Map();
  const calls = [];
  const resolved = new Set();
  const controls = { before: null, after: null, active: 0, peak: 0, failSave: false };
  const detail = (id) => { if (!files.has(id)) files.set(id, makeDetail(id, blockCount)); return files.get(id); };
  const invoke = async (name, args) => {
    controls.active++; controls.peak = Math.max(controls.peak, controls.active);
    calls.push({ name, args: structuredClone(args) });
    try {
      await controls.before?.(name, args);
      let result;
      switch (name.replace('git_worktree_', '')) {
        case 'probe_conflicts': result = probeKind === 'none' ? { kind: 'none', headOid: 'head', baseOid: 'base' } : { kind: 'managed', snapshot }; break;
        case 'prepare_conflicts': result = snapshot; break;
        case 'conflict_status': {
          const end = Math.min(total, args.cursor + args.limit);
          result = { snapshot, nextCursor: end < total ? end : null, files: Array.from({ length: end - args.cursor }, (_, i) => {
            const id = `file-${args.cursor + i}`;
            return { fileId: id, displayPath: `${id}.txt`, stages: [], capability: 'pending', reason: null, resolved: resolved.has(id) };
          }) }; break;
        }
        case 'conflict_file': result = { requestEpoch: args.requestEpoch, detail: detail(args.fileId) }; break;
        case 'save_conflict_draft': {
          if (controls.failSave) throw new Error('disk_full');
          if (applied.has(args.operationId)) { result = applied.get(args.operationId); break; }
          const file = detail(args.fileId);
          if (file.version !== args.version || file.draft.revision !== args.draftRevision) throw new Error('stale_draft');
          file.draft = { ...file.draft, revision: file.draft.revision + 1, choices: structuredClone(args.choices), operationId: args.operationId };
          file.version = `version-${file.draft.revision}`;
          result = file.draft; applied.set(args.operationId, structuredClone(result)); break;
        }
        case 'resolve_conflict_file': case 'take_conflict_side':
          resolved.add(args.fileId); snapshot = { ...snapshot, revision: snapshot.revision + 1, resolved: resolved.size, unresolved: total - resolved.size, state: resolved.size === total ? 'ready' : 'resolving' }; result = snapshot; break;
        case 'continue_conflicts': snapshot = { ...snapshot, revision: snapshot.revision + 1, state: 'completed' }; result = snapshot; break;
        case 'abort_conflicts': snapshot = { ...snapshot, revision: snapshot.revision + 1, state: 'aborted' }; result = snapshot; break;
        case 'recheck_conflicts': result = snapshot; break;
        case 'release_conflicts': result = null; break;
        default: throw new Error(`Unexpected IPC: ${name}`);
      }
      await controls.after?.(name, args);
      return structuredClone(result);
    } finally { controls.active--; }
  };
  return { invoke, calls, controls, detail, context, get snapshot() { return snapshot; } };
}
export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
