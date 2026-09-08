import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const task = path.dirname(fileURLToPath(import.meta.url));
const binary = path.join(task, 'rust-audit/target/debug/refactor-method-audit.exe');
const git = args => execFileSync('git', args, { maxBuffer: 100 * 1024 * 1024 });
function snapshots(ref) {
  const entries = git(['ls-tree', '-rz', ref, '--', 'src-tauri']).toString().split('\0').filter(Boolean)
    .map(line => { const [meta, file] = line.split('\t'); return { file, oid: meta.split(' ')[2] }; })
    .filter(item => item.file.endsWith('.rs') && !item.file.includes('/gen/') && !item.file.includes('/target/'));
  const blobs = execFileSync('git', ['cat-file', '--batch'], { input: entries.map(e => e.oid).join('\n') + '\n', maxBuffer: 100 * 1024 * 1024 });
  let position = 0;
  return entries.map(entry => {
    const end = blobs.indexOf(10, position);
    const size = Number(blobs.subarray(position, end).toString().split(' ')[2]);
    const source = blobs.subarray(end + 1, end + 1 + size).toString();
    position = end + size + 2;
    return { file: entry.file, source };
  });
}
function parse(sources) {
  return JSON.parse(execFileSync(binary, [], { input: JSON.stringify(sources), encoding: 'utf8', maxBuffer: 150 * 1024 * 1024 }));
}
const before = parse(snapshots('33916085^'));
const currentSources = snapshots('HEAD').map(({file}) => ({ file, source: readFileSync(file, 'utf8') }));
const after = parse(currentSources);
const flatten = reports => reports.flatMap(report => report.methods.map(method => ({ ...method, file: report.file })));
const oldMethods = flatten(before);
const newMethods = flatten(after);
const candidates = new Map();
for (const method of newMethods) {
  const list = candidates.get(method.name) ?? [];
  list.push(method);
  candidates.set(method.name, list);
}
const unmatched = [];
let exactBodies = 0;
let formattingOnly = 0;
for (const old of oldMethods) {
  const options = candidates.get(old.name) ?? [];
  if (options.some(candidate => candidate.body === old.body && candidate.kind === old.kind)) { exactBodies++; continue; }
  if (options.some(candidate => candidate.canonicalBody === old.canonicalBody && candidate.kind === old.kind)) { formattingOnly++; continue; }
  unmatched.push({ file: old.file, name: old.name, kind: old.kind, scope: old.scope, line: old.line,
    candidates: options.map(candidate => {
      const a = old.canonicalBody ?? '', b = candidate.canonicalBody ?? '';
      let offset = 0;
      while (offset < a.length && offset < b.length && a[offset] === b[offset]) offset++;
      return { file: candidate.file, line: candidate.line, kind: candidate.kind, scope: candidate.scope,
        firstDifference: { before: a.slice(Math.max(0, offset - 60), offset + 160), after: b.slice(Math.max(0, offset - 60), offset + 160) } };
    }) });
}
const inventory = after.map(report => ({ file: report.file,
  methods: report.methods.map(({ body, canonicalBody, ...method }) => ({ ...method, bodyPresent: body !== null })),
  unexpandedMacros: report.unexpanded_macros.map(({tokens, ...macro}) => macro),
}));
const summary = { baselineFiles: before.length, currentFiles: after.length, baselineMethods: oldMethods.length,
  currentMethods: newMethods.length, exactBodies, formattingOnly, unresolvedMethods: unmatched.length,
  unexpandedMacros: after.reduce((n, r) => n + r.unexpanded_macros.length, 0) };
writeFileSync(path.join(task, 'rust-method-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
writeFileSync(path.join(task, 'rust-method-differences.json'), JSON.stringify({ summary, unmatched }, null, 2) + '\n');
console.log(JSON.stringify(summary));
