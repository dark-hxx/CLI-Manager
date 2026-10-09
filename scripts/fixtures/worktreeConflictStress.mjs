// Linear-time construction, outside measured intervals. No real Git operations.
export function makeStressConflict(fileId = 'file-0') {
  const encoder = new TextEncoder();
  const chunks = [];
  const blocks = [];
  let offset = 0;
  const append = (text) => { chunks.push(text); offset += encoder.encode(text).length; };
  append(`\uFEFF前文😀${'L'.repeat(64000)}\r\n`);
  for (let i = 0; i < 2000; i++) {
    const line = `${i} 中文😀\t${'x'.repeat(212)}\r\n`;
    const base = `target ${line}target ${line}`;
    const worktree = `worktree ${line}worktree ${line}`;
    const start = offset;
    append(`<<<<<<< HEAD\r\n${worktree}=======\r\n${base}>>>>>>> main\r\n`);
    blocks.push({ id: `block-${i}`, start, end: offset, base, worktree, ancestor: null });
    append(i === 1999 ? 'context\r\ncontext\r\n' : 'context\r\ncontext\r\ncontext\r\n');
  }
  const source = chunks.join('');
  return { fileId, version: 'version-0', capability: 'blocks', reason: null, source, blocks,
    draft: { revision: 0, choices: {}, sourceHash: 'source', operationId: '', payloadHash: '' },
    baseExists: true, worktreeExists: true, markerSize: 7 };
}
